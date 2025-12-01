import { useState, useEffect } from "react";
import { collection, query, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { useArduinoConnection } from "@/hooks/useArduinoConnection";
import { TopNav } from "@/components/TopNav";
import { ArduinoConnectionPanel } from "@/components/ArduinoConnectionPanel";
import { ExerciseCard } from "@/components/ExerciseCard";
import { LiveReadingCard } from "@/components/LiveReadingCard";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ClipboardList, Activity as ActivityIcon, Sparkles } from "lucide-react";
import type { AssignedExercise } from "@shared/schema";

// ⭐ NEW IMPORTS
import {
  updateAssignedExercise,
  createExerciseProgress,
  updateExerciseProgress,
} from "@/lib/firestore";

import { useToast } from "@/hooks/use-toast";

interface N8nRecommendation {
  feedback: string;
  recommendedExercise: string;
  rationale: string;
  additionalAdvice: string;
  confidence: number;
}

export default function PatientDashboard() {
  const { userProfile } = useAuth();
  const toast = useToast();

  // Existing states
  const [assignedExercises, setAssignedExercises] = useState<AssignedExercise[]>([]);
  const [recommendations, setRecommendations] = useState<N8nRecommendation[]>([]);
  const [loadingExercises, setLoadingExercises] = useState(true);
  const [loadingRecommendations, setLoadingRecommendations] = useState(true);

  // ⭐ NEW STATES
  const [sessionLoading, setSessionLoading] = useState(false);
  const [activeAssignmentId, setActiveAssignmentId] = useState<string | null>(null);
  const [activeProgressId, setActiveProgressId] = useState<string | null>(null);

  const {
    connected,
    deviceName,
    currentReading,
    isRecording,
    connect,
    disconnect,
    startRecording,
    stopRecording,
  } = useArduinoConnection(userProfile?.uid || "");

  // Fetch Assigned Exercises
  useEffect(() => {
    if (!userProfile) return;

    const exercisesQuery = query(
      collection(db, "patients", userProfile.uid, "assignedExercises")
    );

    const unsubscribe = onSnapshot(exercisesQuery, (snapshot) => {
      const exercises = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as AssignedExercise[];

      setAssignedExercises(exercises);
      setLoadingExercises(false);
    });

    return () => unsubscribe();
  }, [userProfile]);

  // Fetch N8n Recommendations from Firestore
  useEffect(() => {
    if (!userProfile) return;

    const recommendationsQuery = query(
      collection(db, "patients", userProfile.uid, "n8nResponses")
    );

    const unsubscribe = onSnapshot(recommendationsQuery, (snapshot) => {
      const recs: N8nRecommendation[] = [];
      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        if (data.recommendations && Array.isArray(data.recommendations)) {
          data.recommendations.forEach((rec: N8nRecommendation) => {
            recs.push(rec);
          });
        }
      });
      setRecommendations(recs);
      setLoadingRecommendations(false);
    });

    return () => unsubscribe();
  }, [userProfile]);

  // ⭐ Original n8n function (DO NOT TOUCH)
  const fetchNetworkRecommendation = async () => {
    if (!userProfile) return;

    try {
      const response = await fetch(
        "https://hack12.app.n8n.cloud/webhook/patient-query",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            patientId: userProfile.uid,
            //name: userProfile.name,
            condition: "knee_rehabilitation",
          }),
        }
      );

      if (!response.ok) {
        console.error("Failed to fetch n8n response");
        setLoadingRecommendations(false);
        return;
      }

      const data = await response.json();

      if (data?.recommendations && Array.isArray(data.recommendations)) {
        setRecommendations(data.recommendations);
      } else if (data?.recommendedExercise) {
        setRecommendations([data]);
      }

      setLoadingRecommendations(false);
    } catch (error) {
      console.error("Error fetching n8n webhook data:", error);
      setLoadingRecommendations(false);
    }
  };

  // Poll n8n every 30s
  useEffect(() => {
    if (!userProfile) return;
    fetchNetworkRecommendation();
    const interval = setInterval(fetchNetworkRecommendation, 30000);
    return () => clearInterval(interval);
  }, [userProfile]);

  // ⭐ NEW FUNCTION: START EXERCISE
  const handleStartExercise = async (exercise: AssignedExercise) => {
    if (!userProfile?.uid) return;

    if (!connected) {
      toast.toast({
        title: "Device not connected",
        description: "Connect your hardware device before starting the session.",
        variant: "destructive",
      });
      return;
    }

    if (sessionLoading || activeAssignmentId) {
      toast.toast({
        title: "Session already in progress",
        description: "Finish the current exercise before starting another.",
      });
      return;
    }

    setSessionLoading(true);

    try {
      await startRecording(exercise.exerciseId);

      await updateAssignedExercise(userProfile.uid, exercise.id, {
        status: "in_progress",
      });

      const progress = await createExerciseProgress(userProfile.uid, {
        patientId: userProfile.uid,
        exerciseId: exercise.exerciseId,
        assignedExerciseId: exercise.id,
        sessionStartTime: Date.now(),
      });

      setActiveAssignmentId(exercise.id);
      setActiveProgressId(progress.id);

      toast.toast({
        title: "Exercise started",
        description: `${exercise.exerciseName} session has begun.`,
      });
    } catch (error: any) {
      console.error("Error starting exercise:", error);
      stopRecording();

      try {
        await updateAssignedExercise(userProfile.uid, exercise.id, {
          status: exercise.status,
        });
      } catch (revertError) {
        console.error("Failed to revert exercise status:", revertError);
      }

      toast.toast({
        title: "Could not start session",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSessionLoading(false);
    }
  };

  // ⭐ NEW FUNCTION: COMPLETE EXERCISE
  const handleCompleteExercise = async () => {
    if (!userProfile?.uid || !activeAssignmentId) return;

    setSessionLoading(true);

    try {
      stopRecording();

      const completedAt = Date.now();

      await updateAssignedExercise(userProfile.uid, activeAssignmentId, {
        status: "completed",
        completedAt,
      });

      if (activeProgressId) {
        await updateExerciseProgress(userProfile.uid, activeProgressId, {
          status: "completed",
          sessionEndTime: completedAt,
          completedAt,
        });
      }

      toast.toast({
        title: "Exercise completed",
        description: "Great job! Exercise has been marked complete.",
      });

      // ⭐ Call original n8n function
      setTimeout(() => {
        fetchNetworkRecommendation();
      }, 2000);
    } catch (error: any) {
      console.error("Error completing exercise:", error);
      toast.toast({
        title: "Could not complete exercise",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setActiveAssignmentId(null);
      setActiveProgressId(null);
      setSessionLoading(false);
    }
  };

  // ⭐ NEW: Stop recording if exercise is marked completed by backend
  useEffect(() => {
    if (!activeAssignmentId) return;
    const activeExercise = assignedExercises.find((ex) => ex.id === activeAssignmentId);
    if (activeExercise && activeExercise.status === "completed") {
      setActiveAssignmentId(null);
      setActiveProgressId(null);
      stopRecording();
    }
  }, [assignedExercises, activeAssignmentId, stopRecording]);

  // ---- UI Rendering ----

  return (
    <div className="min-h-screen bg-background">
      <TopNav />

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Patient Dashboard</h1>
          <p className="text-muted-foreground">
            Track your exercises and view personalized recommendations
          </p>
          {userProfile?.assignedPhysioId && (
            <Badge variant="outline" className="mt-2">
              <ActivityIcon className="w-3 h-3 mr-1" />
              Supervised by physiotherapist
            </Badge>
          )}
        </div>

        {/* Arduino Panel */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          <div className="lg:col-span-1">
            <ArduinoConnectionPanel
              connected={connected}
              deviceName={deviceName}
              currentReading={currentReading}
              isRecording={isRecording}
              onConnect={connect}
              onDisconnect={disconnect}
              onStartRecording={() => startRecording()}
              onStopRecording={stopRecording}
            />
          </div>

          <div className="lg:col-span-2">
            {connected && currentReading && (
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle className="text-xl">Live Readings</CardTitle>
                  <CardDescription>Real-time data from your device</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <LiveReadingCard label="Angle" value={currentReading.angle} />
                    <LiveReadingCard label="Roll" value={currentReading.roll} />
                    <LiveReadingCard label="Pitch" value={currentReading.pitch} />
                    <LiveReadingCard label="Yaw" value={currentReading.yaw} />
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Assigned Exercises */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="text-2xl font-semibold">Assigned Exercises</CardTitle>
            <CardDescription>Your personalized exercise program</CardDescription>
          </CardHeader>
          <CardContent>
            {loadingExercises ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
              </div>
            ) : assignedExercises.length === 0 ? (
              <div className="text-center py-12">
                <ClipboardList className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">
                  No exercises assigned yet
                </h3>
                <p className="text-muted-foreground">
                  Your physiotherapist will assign exercises soon.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {assignedExercises.map((exercise) => (
                  <ExerciseCard
                    key={exercise.id}
                    exercise={exercise}

                    // ⭐ NEW PROPS
                    progress={
                      exercise.status === "completed"
                        ? 100
                        : exercise.status === "in_progress"
                        ? 50
                        : 0
                    }
                    onStart={() => handleStartExercise(exercise)}
                    onStop={handleCompleteExercise}
                    isActive={activeAssignmentId === exercise.id}
                    isRecording={isRecording}
                    disabled={sessionLoading && activeAssignmentId !== exercise.id}
                    loading={
                      sessionLoading &&
                      activeAssignmentId === exercise.id &&
                      isRecording
                    }
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recommended Exercises */}
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl font-semibold flex items-center">
              <Sparkles className="w-5 h-5 mr-2 text-primary" />
              Recommended Exercises (AI Suggestions)
            </CardTitle>
            <CardDescription>
              Based on your recent exercise data and device readings
            </CardDescription>
          </CardHeader>

          <CardContent>
            {loadingRecommendations ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
              </div>
            ) : recommendations.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                No AI recommendations yet. They’ll appear once new n8n responses are received.
              </p>
            ) : (
              <div className="space-y-6">
                {recommendations.map((rec, index) => (
                  <div
                    key={index}
                    className="p-6 border rounded-lg bg-muted/40 hover:bg-muted/60 transition"
                  >
                    <h3 className="text-lg font-semibold text-primary mb-2">
                      {rec.recommendedExercise}
                    </h3>
                    <p className="text-sm text-muted-foreground mb-2">
                      <strong>Feedback:</strong> {rec.feedback}
                    </p>
                    <p className="text-sm text-muted-foreground mb-2">
                      <strong>Rationale:</strong> {rec.rationale}
                    </p>
                    <p className="text-sm text-muted-foreground mb-2">
                      <strong>Additional Advice:</strong> {rec.additionalAdvice}
                    </p>
                    <p className="text-xs text-muted-foreground italic">
                      Confidence: {(rec.confidence * 100).toFixed(1)}%
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}