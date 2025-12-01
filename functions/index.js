/**
 * Firebase Cloud Functions for PhysioTrack
 * 
 * Functions:
 * 1. onReadingCreated - Triggers when new Arduino reading is saved
 *    - Posts reading data to n8n webhook
 *    - Updates Firestore with webhook response
 * 
 * 2. updateExerciseProgress - Calculates exercise progress from readings
 *    - Counts reps when readings fall within target range
 *    - Marks exercises as completed when threshold reached
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

/**
 * Trigger when a new reading is created
 * POST the reading to n8n webhook and update Firestore with response
 */
exports.onReadingCreated = functions.firestore
  .document("readings/{patientId}/events/{readingId}")
  .onCreate(async (snapshot, context) => {
    const reading = snapshot.data();
    const { patientId, readingId } = context.params;

    // n8n webhook URL - should be configured as environment variable
    const webhookUrl = functions.config().n8n?.webhook_url || 
                      "https://hack12.app.n8n.cloud/webhook/patient-query";

    try {
      // Prepare payload for n8n
      const payload = {
        timestamp: new Date(reading.timestamp).toISOString(),
        arduino_data: {
          knee_angle: reading.angle,
          roll: reading.roll,
          pitch: reading.pitch,
          yaw: reading.yaw,
          recording_status: reading.exerciseId ? "active" : "passive"
        },
        source: "arduino_knee_monitor",
        patientId: patientId,
        exerciseId: reading.exerciseId || null,
        readingId: readingId
      };

      // Send POST request to n8n webhook
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const responseData = await response.text();
      const statusCode = response.status;

      // Update Firestore document with webhook response
      await snapshot.ref.update({
        sentToN8N: true,
        n8nResponse: responseData,
        n8nStatusCode: statusCode,
      });

      console.log(`Successfully sent reading ${readingId} to n8n webhook`);
      return { success: true, statusCode };
    } catch (error) {
      console.error("Error sending to n8n webhook:", error);
      
      // Update document to indicate failure
      await snapshot.ref.update({
        sentToN8N: false,
        n8nResponse: error.message,
        n8nStatusCode: 0,
      });

      return { success: false, error: error.message };
    }
  });

/**
 * Calculate exercise progress based on readings
 * Counts reps when angle is within target range
 */
exports.updateExerciseProgress = functions.firestore
  .document("readings/{patientId}/events/{readingId}")
  .onCreate(async (snapshot, context) => {
    const reading = snapshot.data();
    const { patientId, readingId } = context.params;

    // Only process readings associated with an exercise
    if (!reading.exerciseId) {
      return null;
    }

    try {
      // Get the assigned exercise details
      const assignedExerciseQuery = await db
        .collection("patients")
        .doc(patientId)
        .collection("assignedExercises")
        .where("exerciseId", "==", reading.exerciseId)
        .where("status", "in", ["assigned", "in_progress"])
        .limit(1)
        .get();

      if (assignedExerciseQuery.empty) {
        console.log(`No active assigned exercise found for exercise ${reading.exerciseId}`);
        return null;
      }

      const assignedExerciseDoc = assignedExerciseQuery.docs[0];
      const assignedExercise = assignedExerciseDoc.data();

      // Find or create active progress session
      const progressQuery = await db
        .collection("progress")
        .doc(patientId)
        .collection("exerciseProgress")
        .where("assignedExerciseId", "==", assignedExerciseDoc.id)
        .where("status", "==", "active")
        .limit(1)
        .get();

      let progressDoc;
      let progressData;

      if (progressQuery.empty) {
        // Create new progress session
        progressDoc = await db
          .collection("progress")
          .doc(patientId)
          .collection("exerciseProgress")
          .add({
            patientId: patientId,
            exerciseId: reading.exerciseId,
            assignedExerciseId: assignedExerciseDoc.id,
            sessionStartTime: reading.timestamp,
            repsCompleted: 0,
            status: "active",
            readingIds: [readingId],
            minAngle: reading.angle,
            maxAngle: reading.angle,
          });

        progressData = {
          repsCompleted: 0,
          readingIds: [readingId],
          minAngle: reading.angle,
          maxAngle: reading.angle,
        };
      } else {
        progressDoc = progressQuery.docs[0].ref;
        progressData = progressQuery.docs[0].data();
      }

      // Check if angle is within target range for rep counting
      const inRange = reading.angle >= assignedExercise.targetAngleMin &&
                     reading.angle <= assignedExercise.targetAngleMax;

      // Update progress with new reading
      const updates = {
        readingIds: admin.firestore.FieldValue.arrayUnion(readingId),
        minAngle: Math.min(progressData.minAngle || reading.angle, reading.angle),
        maxAngle: Math.max(progressData.maxAngle || reading.angle, reading.angle),
      };

      // Simple rep counting logic: count each time we enter the target range
      // (More sophisticated logic could track full movement cycles)
      if (inRange) {
        const previousReadingsCount = progressData.readingIds?.length || 0;
        
        // Get the previous reading to check if we just entered the range
        if (previousReadingsCount > 0) {
          const previousReadingId = progressData.readingIds[previousReadingsCount - 1];
          const previousReadingDoc = await db
            .collection("readings")
            .doc(patientId)
            .collection("events")
            .doc(previousReadingId)
            .get();

          if (previousReadingDoc.exists()) {
            const previousReading = previousReadingDoc.data();
            const wasOutOfRange = previousReading.angle < assignedExercise.targetAngleMin ||
                                 previousReading.angle > assignedExercise.targetAngleMax;

            // Increment rep if we just entered the range
            if (wasOutOfRange) {
              updates.repsCompleted = (progressData.repsCompleted || 0) + 1;
            }
          }
        }
      }

      // Calculate average angle
      const allReadings = [...(progressData.readingIds || []), readingId];
      if (allReadings.length > 0) {
        const readingsSnapshot = await db
          .collection("readings")
          .doc(patientId)
          .collection("events")
          .where(admin.firestore.FieldPath.documentId(), "in", allReadings.slice(-10))
          .get();

        const angles = readingsSnapshot.docs.map(doc => doc.data().angle);
        updates.averageAngle = angles.reduce((sum, angle) => sum + angle, 0) / angles.length;
      }

      // Check if exercise is completed
      if (updates.repsCompleted >= assignedExercise.targetReps) {
        updates.status = "completed";
        updates.sessionEndTime = reading.timestamp;
        updates.completedAt = Date.now();

        // Update assigned exercise status
        await assignedExerciseDoc.ref.update({
          status: "completed",
          completedAt: Date.now(),
        });

        console.log(`Exercise ${reading.exerciseId} completed for patient ${patientId}`);
      }

      await progressDoc.update(updates);
      console.log(`Updated progress for exercise ${reading.exerciseId}`);

      return { success: true, repsCompleted: updates.repsCompleted };
    } catch (error) {
      console.error("Error updating exercise progress:", error);
      return { success: false, error: error.message };
    }
  });
