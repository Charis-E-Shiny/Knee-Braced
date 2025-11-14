import { useState, useEffect, useCallback, useMemo } from "react";
import { collection, query, onSnapshot, where, orderBy, limit, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { useArduinoConnection } from "@/hooks/useArduinoConnection";
import {
  updateAssignedExercise,
  createExerciseProgress,
  updateExerciseProgress,
} from "@/lib/firestore";
import { useToast } from "@/hooks/use-toast";
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
import { Button } from "@/components/ui/button";
import { ClipboardList, Activity as ActivityIcon, Sparkles, RefreshCw } from "lucide-react";
import type { AssignedExercise } from "@shared/schema";

interface N8nRecommendation {
  feedback: string;
  recommendedExercise: string;
  rationale: string;
  additionalAdvice: string;
  confidence: number;
}

export default function PatientDashboard() {
  const { userProfile } = useAuth();
  const { toast } = useToast();
  const [assignedExercises, setAssignedExercises] = useState<AssignedExercise[]>([]);
  const [firestoreRecommendations, setFirestoreRecommendations] = useState<N8nRecommendation[]>([]);
  const [networkRecommendations, setNetworkRecommendations] = useState<N8nRecommendation[]>([]);
  const [loadingExercises, setLoadingExercises] = useState(true);
  const [loadingNetworkRecommendations, setLoadingNetworkRecommendations] = useState(true);
  const [loadingFirestoreRecommendations, setLoadingFirestoreRecommendations] = useState(true);
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

  const recommendations = useMemo(() => {
    const combined = [...firestoreRecommendations, ...networkRecommendations];
    const seen = new Set<string>();
    return combined.filter((rec) => {
      const key = `${rec.recommendedExercise}-${rec.feedback}-${rec.rationale}-${rec.additionalAdvice}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [firestoreRecommendations, networkRecommendations]);

  const recommendationsLoading = loadingNetworkRecommendations || loadingFirestoreRecommendations;

  // 🟢 Fetch Assigned Exercises
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

  // 🟢 Fetch N8n Recommendations stored in Firestore
  useEffect(() => {
    if (!userProfile) return;

    const recommendationsQuery = query(
      collection(db, "patients", userProfile.uid, "n8nResponses")
    );

    const unsubscribe = onSnapshot(
      recommendationsQuery,
      (snapshot) => {
        const recs: N8nRecommendation[] = [];
        snapshot.docs.forEach((doc) => {
          const data = doc.data();
          if (data.recommendations && Array.isArray(data.recommendations)) {
            data.recommendations.forEach((rec: N8nRecommendation) => recs.push(rec));
          }
        });
        setFirestoreRecommendations(recs);
        setLoadingFirestoreRecommendations(false);
      },
      (error) => {
        console.error("Error fetching Firestore recommendations:", error);
        setFirestoreRecommendations([]);
        setLoadingFirestoreRecommendations(false);
      }
    );

    return () => unsubscribe();
  }, [userProfile]);

  // 🟢 Fetch N8n Recommendations from API
  const fetchN8nRecommendations = useCallback(async () => {
    if (!userProfile?.uid) return;

    setLoadingNetworkRecommendations(true);
    try {
      // Fetch recent readings to send to n8n for recommendations
      let readingsSnapshot;
      try {
        const readingsQuery = query(
          collection(db, "readings"),
          where("patientId", "==", userProfile.uid),
          orderBy("timestamp", "desc"),
          limit(20) // Get recent readings for context
        );
        readingsSnapshot = await getDocs(readingsQuery);
      } catch (error: any) {
        // If ordered query fails, try without orderBy
        if (error.code === "failed-precondition" || error.code === 9) {
          console.warn("Ordered query failed, using simple filter for recommendations");
          const fallbackQuery = query(
            collection(db, "readings"),
            where("patientId", "==", userProfile.uid),
            limit(20)
          );
          readingsSnapshot = await getDocs(fallbackQuery);
        } else {
          throw error;
        }
      }
      const recentReadings = readingsSnapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as Array<{
        id: string;
        angle?: number;
        timestamp?: number;
        exerciseId?: string;
        [key: string]: any;
      }>;

      // Prepare payload for n8n recommendation request
      const payload = {
        patientId: userProfile.uid,
        recentReadings: recentReadings.slice(0, 10).map((r) => ({
          angle: r.angle || 0,
          timestamp: r.timestamp || Date.now(),
          exerciseId: r.exerciseId || "",
        })),
        requestType: "recommendations",
      };

      console.log("📡 Fetching recommendations from n8n...", payload);

      // Call backend proxy to avoid CORS issues
      const response = await fetch("/api/n8n/patient-query-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const n8nData = await response.json();
      console.log("🤖 n8n Recommendation Response:", n8nData);

      // Parse recommendations from n8n response
      const recs: N8nRecommendation[] = [];
      
      if (Array.isArray(n8nData)) {
        // If response is an array, check each item for recommendations
        n8nData.forEach((item: any) => {
          if (item.recommendations && Array.isArray(item.recommendations)) {
            item.recommendations.forEach((rec: any) => {
              recs.push({
                feedback: rec.feedback || rec.Feedback || "",
                recommendedExercise: rec.recommendedExercise || rec.RecommendedExercise || rec.exercise || "",
                rationale: rec.rationale || rec.Rationale || "",
                additionalAdvice: rec.additionalAdvice || rec.AdditionalAdvice || rec.advice || "",
                confidence: rec.confidence || rec.Confidence || 0.8,
              });
            });
          } else if (item.feedback || item.recommendedExercise) {
            // Direct recommendation object
            recs.push({
              feedback: item.feedback || item.Feedback || "",
              recommendedExercise: item.recommendedExercise || item.RecommendedExercise || item.exercise || "",
              rationale: item.rationale || item.Rationale || "",
              additionalAdvice: item.additionalAdvice || item.AdditionalAdvice || item.advice || "",
              confidence: item.confidence || item.Confidence || 0.8,
            });
          }
        });
      } else if (n8nData.recommendations && Array.isArray(n8nData.recommendations)) {
        // If recommendations are directly in response
        n8nData.recommendations.forEach((rec: any) => {
          recs.push({
            feedback: rec.feedback || rec.Feedback || "",
            recommendedExercise: rec.recommendedExercise || rec.RecommendedExercise || rec.exercise || "",
            rationale: rec.rationale || rec.Rationale || "",
            additionalAdvice: rec.additionalAdvice || rec.AdditionalAdvice || rec.advice || "",
            confidence: rec.confidence || rec.Confidence || 0.8,
          });
        });
      } else if (n8nData.feedback || n8nData.recommendedExercise) {
        // Single recommendation object
        recs.push({
          feedback: n8nData.feedback || n8nData.Feedback || "",
          recommendedExercise: n8nData.recommendedExercise || n8nData.RecommendedExercise || n8nData.exercise || "",
          rationale: n8nData.rationale || n8nData.Rationale || "",
          additionalAdvice: n8nData.additionalAdvice || n8nData.AdditionalAdvice || n8nData.advice || "",
          confidence: n8nData.confidence || n8nData.Confidence || 0.8,
        });
      }

      console.log("✅ Parsed recommendations:", recs);
      setNetworkRecommendations(recs);
    } catch (error: any) {
      console.error("❌ Error fetching n8n recommendations:", error);
      toast({
        title: "Could not fetch recommendations",
        description: error.message || "Please try again later.",
        variant: "default",
      });
      setNetworkRecommendations([]);
    } finally {
      setLoadingNetworkRecommendations(false);
    }
  }, [userProfile?.uid, toast]);

  useEffect(() => {
    if (!userProfile?.uid) return;

    // Fetch recommendations on mount
    fetchN8nRecommendations();

    // Refresh recommendations every 30 seconds if there's activity
    const interval = setInterval(() => {
      if (connected || isRecording) {
        fetchN8nRecommendations();
      }
    }, 30000); // 30 seconds

    return () => clearInterval(interval);
  }, [userProfile, connected, isRecording, fetchN8nRecommendations]);

  const handleStartExercise = async (exercise: AssignedExercise) => {
    if (!userProfile?.uid) return;

    if (!connected) {
      toast({
        title: "Device not connected",
        description: "Connect your hardware device before starting the session.",
        variant: "destructive",
      });
      return;
    }

    if (sessionLoading || activeAssignmentId) {
      toast({
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

      toast({
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

      toast({
        title: "Could not start session",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSessionLoading(false);
    }
  };

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

      toast({
        title: "Exercise completed",
        description: "Great job! Exercise has been marked complete.",
      });

      // Refresh recommendations after exercise completion
      setTimeout(() => {
        fetchN8nRecommendations();
      }, 2000); // Wait 2 seconds for readings to be processed
    } catch (error: any) {
      console.error("Error completing exercise:", error);
      toast({
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

  useEffect(() => {
    if (!activeAssignmentId) return;
    const activeExercise = assignedExercises.find((ex) => ex.id === activeAssignmentId);
    if (activeExercise && activeExercise.status === "completed") {
      setActiveAssignmentId(null);
      setActiveProgressId(null);
      stopRecording();
    }
  }, [assignedExercises, activeAssignmentId, stopRecording]);

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

        {/* 🔹 Arduino + Live Readings Section */}
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

        {/* 🔹 Assigned Exercises Section */}
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
                      sessionLoading && activeAssignmentId === exercise.id && isRecording
                    }
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 🔹 Recommended Exercises Section (from n8n) */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-2xl font-semibold flex items-center">
                  <Sparkles className="w-5 h-5 mr-2 text-primary" />
                  Recommended Exercises (AI Suggestions)
                </CardTitle>
                <CardDescription>
                  Based on your recent exercise data and device readings
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={fetchN8nRecommendations}
                disabled={loadingNetworkRecommendations}
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${loadingNetworkRecommendations ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {recommendationsLoading ? (
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
