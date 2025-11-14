import { useState, useEffect, useMemo } from "react";
import { collection, query, onSnapshot, orderBy, limit, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExerciseCard } from "@/components/ExerciseCard";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ClipboardList, Activity, TrendingUp, Clock, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import jsPDF from "jspdf";
import type { User, AssignedExercise, Reading } from "@shared/schema";

interface PatientDetailDialogProps {
  patient: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PatientDetailDialog({
  patient,
  open,
  onOpenChange,
}: PatientDetailDialogProps) {
  const { toast } = useToast();
  const [assignedExercises, setAssignedExercises] = useState<AssignedExercise[]>([]);
  const [recentReadings, setRecentReadings] = useState<Reading[]>([]);
  const [loadingExercises, setLoadingExercises] = useState(true);
  const [loadingReadings, setLoadingReadings] = useState(true);

  useEffect(() => {
    if (!open || !patient.uid) return;

    // Fetch assigned exercises
    const exercisesQuery = query(
      collection(db, "patients", patient.uid, "assignedExercises"),
      orderBy("assignedAt", "desc")
    );

    const unsubscribeExercises = onSnapshot(
      exercisesQuery,
      (snapshot) => {
        const exercises = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as AssignedExercise[];
        setAssignedExercises(exercises);
        setLoadingExercises(false);
      },
      (error) => {
        console.error("Error fetching assigned exercises:", error);
        setAssignedExercises([]);
        setLoadingExercises(false);
      }
    );

    // Fetch recent readings - query from main readings collection filtered by patientId
    // Try with orderBy first, fallback to simple filter if index missing
    console.log(`Fetching readings for patient: ${patient.uid}`);
    let readingsQuery;
    try {
      readingsQuery = query(
        collection(db, "readings"),
        where("patientId", "==", patient.uid),
        orderBy("timestamp", "desc"),
        limit(500) // Get more readings for comprehensive ROM analysis
      );
    } catch (error) {
      // Fallback: query without orderBy if index not available
      console.warn("Ordered query failed, using simple filter:", error);
      readingsQuery = query(
        collection(db, "readings"),
        where("patientId", "==", patient.uid),
        limit(500)
      );
    }

    const unsubscribeReadings = onSnapshot(
      readingsQuery,
      (snapshot) => {
        const readings = snapshot.docs.map((doc) => {
          const data = doc.data();
          return {
            id: doc.id,
            ...data,
          } as Reading;
        });
        
        // Sort manually if orderBy failed
        readings.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        const sortedReadings = readings.slice(0, 500);
        
        console.log(`✅ Fetched ${sortedReadings.length} readings for patient ${patient.uid}`);
        if (sortedReadings.length > 0) {
          console.log("Sample reading:", sortedReadings[0]);
          console.log("All readings:", sortedReadings);
        } else {
          console.warn("⚠️ No readings found - checking if patientId matches...");
          // Debug: Try to see all readings to check structure
          console.log("Query details: collection=readings, filter=patientId==", patient.uid);
        }
        setRecentReadings(sortedReadings);
        setLoadingReadings(false);
      },
      (error: any) => {
        console.error("Error fetching readings:", error);
        console.error("Error code:", error.code);
        console.error("Error message:", error.message);
        
        // If ordered query fails due to missing index, try simple filter
        if (error.code === "failed-precondition" || error.code === 9) {
          console.log("Attempting fallback query without orderBy...");
          const fallbackQuery = query(
            collection(db, "readings"),
            where("patientId", "==", patient.uid),
            limit(50)
          );
          
          onSnapshot(
            fallbackQuery,
            (snapshot) => {
              const readings = snapshot.docs.map((doc) => {
                const data = doc.data();
                return {
                  id: doc.id,
                  ...data,
                } as Reading;
              });
              
              // Sort manually
              readings.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
              const sortedReadings = readings.slice(0, 500);
              
              console.log(`✅ Fallback query fetched ${sortedReadings.length} readings`);
              if (sortedReadings.length > 0) {
                console.log("Sample reading from fallback:", sortedReadings[0]);
              }
              setRecentReadings(sortedReadings);
              setLoadingReadings(false);
            },
            (fallbackError) => {
              console.error("Fallback query also failed:", fallbackError);
              setRecentReadings([]);
              setLoadingReadings(false);
            }
          );
        } else {
          setRecentReadings([]);
          setLoadingReadings(false);
        }
      }
    );

    return () => {
      unsubscribeExercises();
      unsubscribeReadings();
    };
  }, [open, patient.uid]);

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase();
  };

  const totalExercises = assignedExercises.length;
  const completedExercises = assignedExercises.filter(
    (ex) => ex.status === "completed"
  ).length;
  const inProgressExercises = assignedExercises.filter(
    (ex) => ex.status === "in_progress"
  ).length;
  const complianceRate =
    totalExercises > 0 ? Math.round((completedExercises / totalExercises) * 100) : 0;

  const romMetrics = useMemo(() => {
    if (recentReadings.length === 0) return null;

    const angles = recentReadings.map((reading) => reading.angle);
    const maxAngle = Math.max(...angles);
    const minAngle = Math.min(...angles);
    const range = maxAngle - minAngle;
    const averageAngle = angles.reduce((sum, angle) => sum + angle, 0) / angles.length;
    const extensionDeficit = Math.max(0, Math.abs(minAngle));
    const flexionGoal = 125;
    const rangeProgress = Math.min(100, Math.round((range / flexionGoal) * 100));

    let status: "excellent" | "onTrack" | "needsAttention";
    if (range >= 125 && extensionDeficit <= 3) status = "excellent";
    else if (range >= 105 && extensionDeficit <= 5) status = "onTrack";
    else status = "needsAttention";

    return {
      maxAngle,
      minAngle,
      range,
      averageAngle,
      extensionDeficit,
      rangeProgress,
      status,
      readingCount: angles.length,
      latestTimestamp: recentReadings[0]?.timestamp ?? null,
    };
  }, [recentReadings]);

  const romStatusLabel = useMemo(() => {
    if (!romMetrics) return "No ROM data recorded";
    switch (romMetrics.status) {
      case "excellent":
        return "Excellent (target met)";
      case "onTrack":
        return "On track – continue progressive loading";
      case "needsAttention":
        return "Needs attention – prioritise ROM restoration";
      default:
        return "ROM status";
    }
  }, [romMetrics]);

  const handleDownloadReport = () => {
    try {
      const doc = new jsPDF();
      const generatedAt = new Date();

      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      doc.text("ACL Rehabilitation ROM Progress Report", 105, 20, { align: "center" });

      doc.setFont("helvetica", "normal");
      doc.setFontSize(12);
      doc.text(`Patient: ${patient.displayName}`, 14, 32);
      doc.text(`Email: ${patient.email}`, 14, 38);
      doc.text(`Report Generated: ${generatedAt.toLocaleString()}`, 14, 44);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.text("Range of Motion Summary", 14, 58);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(12);

      if (romMetrics) {
        const romLines = [
          `Max Flexion: ${romMetrics.maxAngle.toFixed(1)}°`,
          `Max Extension: ${romMetrics.minAngle.toFixed(1)}°`,
          `Total ROM: ${romMetrics.range.toFixed(1)}° (${romMetrics.rangeProgress}% of 125° goal)`,
          `Average Knee Angle (recent session): ${romMetrics.averageAngle.toFixed(1)}°`,
          `Extension Deficit from 0°: ${romMetrics.extensionDeficit.toFixed(1)}°`,
          `Readings Analysed: ${romMetrics.readingCount}`,
        ];
        doc.text(romLines, 14, 66);
      } else {
        doc.text("No ROM recordings available yet.", 14, 66);
      }

      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.text("Exercise Compliance", 14, 98);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(12);
      doc.text(
        [
          `Assigned Exercises: ${totalExercises}`,
          `Completed Exercises: ${completedExercises}`,
          `In Progress Exercises: ${inProgressExercises}`,
          `Compliance Rate: ${complianceRate}%`,
        ],
        14,
        106
      );

      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.text("ACL Tear Rehabilitation Guidance", 14, 134);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(12);
      const recommendations = doc.splitTextToSize(
        [
          "• Maintain full extension (0°) to minimise anterior knee stress and restore gait symmetry.",
          "• Progress flexion toward 125°+ with heel slides, wall slides, and stationary bike work.",
          "• Emphasise quadriceps activation (quad sets, straight leg raises) to protect graft integrity.",
          "• Introduce closed-chain strengthening (mini squats, leg press 0-60°) as ROM normalises.",
          "• Monitor post-session swelling; reduce load if effusion or pain escalates.",
        ].join("\n"),
        180
      );
      doc.text(recommendations, 14, 142);

      doc.setFont("helvetica", "italic");
      doc.setFontSize(10);
      doc.text(
        "Report tailored for ACL tear rehabilitation. Use alongside clinical judgement.",
        14,
        196
      );

      doc.save(`${patient.displayName.replace(/\s+/g, "_")}_ACL_ROM_Report.pdf`);
      toast({
        title: "Report downloaded",
        description: "ACL ROM progress report saved as PDF.",
      });
    } catch (error: any) {
      console.error("Error generating report:", error);
      toast({
        title: "Report generation failed",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-center gap-4">
              <Avatar className="w-16 h-16">
                <AvatarFallback className="bg-primary text-primary-foreground text-xl">
                  {getInitials(patient.displayName)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <DialogTitle className="text-2xl">{patient.displayName}</DialogTitle>
                <DialogDescription>{patient.email}</DialogDescription>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant="outline">Patient</Badge>
              <Button className="gap-2" onClick={handleDownloadReport}>
                <Download className="w-4 h-4" />
                Download ACL Report
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 mt-6">
          {/* Stats Overview */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Total Exercises</p>
                    <p className="text-2xl font-bold">{totalExercises}</p>
                  </div>
                  <ClipboardList className="w-8 h-8 text-primary opacity-50" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Completed</p>
                    <p className="text-2xl font-bold text-green-600">{completedExercises}</p>
                  </div>
                  <TrendingUp className="w-8 h-8 text-green-600 opacity-50" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">In Progress</p>
                    <p className="text-2xl font-bold text-blue-600">{inProgressExercises}</p>
                  </div>
                  <Activity className="w-8 h-8 text-blue-600 opacity-50" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Recent Readings</p>
                    <p className="text-2xl font-bold">{recentReadings.length}</p>
                  </div>
                  <Clock className="w-8 h-8 text-purple-600 opacity-50" />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ACL Range of Motion Focus */}
          <Card>
            <CardHeader>
              <CardTitle>ACL Range of Motion Focus</CardTitle>
              <CardDescription>
                Monitoring flexion and extension targets specific to ACL tear rehab
              </CardDescription>
            </CardHeader>
            <CardContent>
              {romMetrics ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-4">
                    <div>
                      <p className="text-xs uppercase text-muted-foreground tracking-wide">
                        Current Status
                      </p>
                      <p className="text-lg font-semibold">{romStatusLabel}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">Max Flexion</p>
                        <p className="font-semibold">{romMetrics.maxAngle.toFixed(1)}°</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Max Extension</p>
                        <p className="font-semibold">{romMetrics.minAngle.toFixed(1)}°</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Total ROM Achieved</p>
                        <p className="font-semibold">
                          {romMetrics.range.toFixed(1)}° ({romMetrics.rangeProgress}% of target)
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Extension Deficit</p>
                        <p className="font-semibold">
                          {romMetrics.extensionDeficit.toFixed(1)}°
                        </p>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Latest session recorded{" "}
                      {romMetrics.latestTimestamp
                        ? new Date(romMetrics.latestTimestamp).toLocaleString()
                        : "N/A"}
                    </p>
                  </div>
                  <div className="space-y-3 text-sm">
                    <p className="font-semibold">Next Priorities</p>
                    <ul className="list-disc pl-5 space-y-2 text-muted-foreground">
                      <li>
                        Maintain full extension (0°) after sessions to reduce anterior knee strain.
                      </li>
                      <li>
                        Progress flexion toward 125°+ with heel slides, wall slides, and bike work.
                      </li>
                      <li>
                        Pair ROM drills with quadriceps activation (quad sets, NMES).
                      </li>
                      <li>Monitor swelling; deload if effusion or pain escalates.</li>
                    </ul>
                  </div>
                </div>
              ) : (
                <div className="text-center py-10 text-muted-foreground">
                  No ROM data captured yet. Encourage a recorded hardware session.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Assigned Exercises */}
          <Card>
            <CardHeader>
              <CardTitle>Assigned Exercises</CardTitle>
              <CardDescription>Exercises assigned to this patient</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingExercises ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
                </div>
              ) : assignedExercises.length === 0 ? (
                <div className="text-center py-12">
                  <ClipboardList className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
                  <p className="text-muted-foreground">No exercises assigned yet</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Readings */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Readings</CardTitle>
              <CardDescription>Latest device readings from this patient</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingReadings ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
                </div>
              ) : recentReadings.length === 0 ? (
                <div className="text-center py-12">
                  <Activity className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
                  <p className="text-muted-foreground">No readings available yet</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {recentReadings.map((reading) => (
                    <div
                      key={reading.id}
                      className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition"
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-4">
                          <div>
                            <p className="text-sm font-medium">Angle: {reading.angle.toFixed(1)}°</p>
                            <p className="text-xs text-muted-foreground">
                              {new Date(reading.timestamp).toLocaleString()}
                            </p>
                          </div>
                          <div className="text-sm text-muted-foreground">
                            <p>Roll: {reading.roll.toFixed(2)}</p>
                            <p>Pitch: {reading.pitch.toFixed(2)}</p>
                            <p>Yaw: {reading.yaw.toFixed(2)}</p>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {reading.sentToN8N && (
                          <Badge variant="outline" className="text-xs">
                            Sent to n8n
                          </Badge>
                        )}
                        {reading.exerciseId && (
                          <Badge variant="secondary" className="text-xs">
                            Exercise Active
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </DialogContent>
    </Dialog>
  );
}
