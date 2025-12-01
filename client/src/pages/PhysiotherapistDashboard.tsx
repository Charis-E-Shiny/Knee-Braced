import { useState, useEffect } from "react";
import { collection, query, where, getDocs, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { TopNav } from "@/components/TopNav";
import { AssignPatientDialog } from "@/components/AssignPatientDialog";
import { CreateExerciseDialog } from "@/components/CreateExerciseDialog";
import { AssignExerciseDialog } from "@/components/AssignExerciseDialog";
import { PatientDetailDialog } from "@/components/PatientDetailDialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/StatusBadge";
import { Users, Activity, ClipboardList, TrendingUp, Plus, Eye } from "lucide-react";
import type { User, AssignedExercise } from "@shared/schema";

interface PatientWithExercises extends User {
  assignedExercises: AssignedExercise[];
  totalExercises: number;
  completedExercises: number;
}

export default function PhysiotherapistDashboard() {
  const { userProfile } = useAuth();
  const [patients, setPatients] = useState<PatientWithExercises[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<User | null>(null);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [stats, setStats] = useState({
    totalPatients: 0,
    activeToday: 0,
    totalExercises: 0,
    completionRate: 0,
  });
  const [loading, setLoading] = useState(true);

  const loadPatients = async () => {
    if (!userProfile) return;

    try {
      const patientsQuery = query(
        collection(db, "users"),
        where("role", "==", "patient"),
        where("assignedPhysioId", "==", userProfile.uid)
      );
      
      const snapshot = await getDocs(patientsQuery);
      const patientsData = snapshot.docs.map(doc => doc.data() as User);
      
      // Fetch assigned exercises for each patient
      const patientsWithExercises = await Promise.all(
        patientsData.map(async (patient) => {
          try {
            const exercisesQuery = query(
              collection(db, "patients", patient.uid, "assignedExercises")
            );
            const exercisesSnapshot = await getDocs(exercisesQuery);
            const assignedExercises = exercisesSnapshot.docs.map((doc) => ({
              id: doc.id,
              ...doc.data(),
            })) as AssignedExercise[];
            
            const totalExercises = assignedExercises.length;
            const completedExercises = assignedExercises.filter(
              (ex) => ex.status === "completed"
            ).length;
            
            return {
              ...patient,
              assignedExercises,
              totalExercises,
              completedExercises,
            } as PatientWithExercises;
          } catch (error) {
            console.error(`Error fetching exercises for patient ${patient.uid}:`, error);
            return {
              ...patient,
              assignedExercises: [],
              totalExercises: 0,
              completedExercises: 0,
            } as PatientWithExercises;
          }
        })
      );
      
      setPatients(patientsWithExercises);
      
      // Calculate stats
      const totalExercises = patientsWithExercises.reduce(
        (sum, p) => sum + p.totalExercises,
        0
      );
      const totalCompleted = patientsWithExercises.reduce(
        (sum, p) => sum + p.completedExercises,
        0
      );
      const completionRate = totalExercises > 0 
        ? Math.round((totalCompleted / totalExercises) * 100) 
        : 0;
      
      setStats({
        totalPatients: patientsWithExercises.length,
        activeToday: 0, // TODO: Calculate based on recent activity
        totalExercises,
        completionRate,
      });
    } catch (error) {
      console.error("Error fetching patients:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPatients();
  }, [userProfile]);

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase();
  };

  return (
    <div className="min-h-screen bg-background">
      <TopNav />
      
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Physiotherapist Dashboard</h1>
          <p className="text-muted-foreground">
            Monitor your patients and track their progress
          </p>
        </div>

        {/* Stats Overview */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                    Total Patients
                  </p>
                  <p className="text-4xl font-bold mt-2" data-testid="stat-total-patients">
                    {stats.totalPatients}
                  </p>
                </div>
                <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
                  <Users className="w-6 h-6 text-primary" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                    Active Today
                  </p>
                  <p className="text-4xl font-bold mt-2" data-testid="stat-active-today">
                    {stats.activeToday}
                  </p>
                </div>
                <div className="w-12 h-12 bg-green-500/10 rounded-lg flex items-center justify-center">
                  <Activity className="w-6 h-6 text-green-500" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                    Total Exercises
                  </p>
                  <p className="text-4xl font-bold mt-2" data-testid="stat-total-exercises">
                    {stats.totalExercises}
                  </p>
                </div>
                <div className="w-12 h-12 bg-blue-500/10 rounded-lg flex items-center justify-center">
                  <ClipboardList className="w-6 h-6 text-blue-500" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                    Completion Rate
                  </p>
                  <p className="text-4xl font-bold mt-2" data-testid="stat-completion-rate">
                    {stats.completionRate}%
                  </p>
                </div>
                <div className="w-12 h-12 bg-purple-500/10 rounded-lg flex items-center justify-center">
                  <TrendingUp className="w-6 h-6 text-purple-500" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Patient Management Section */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <CardTitle className="text-2xl font-semibold">My Patients</CardTitle>
                <CardDescription>View and manage patient assignments</CardDescription>
              </div>
              <div className="flex gap-2">
                {userProfile && <CreateExerciseDialog physioId={userProfile.uid} onExerciseCreated={loadPatients} />}
                {userProfile && (
                  <AssignPatientDialog physioId={userProfile.uid} onPatientAssigned={loadPatients} />
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
              </div>
            ) : patients.length === 0 ? (
              <div className="text-center py-12">
                <Users className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No patients yet</h3>
                <p className="text-muted-foreground mb-4">
                  Start by adding patients to monitor their progress
                </p>
                {userProfile && (
                  <AssignPatientDialog physioId={userProfile.uid} onPatientAssigned={loadPatients} />
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {patients.map((patient) => (
                  <Card key={patient.uid} className="hover-elevate" data-testid={`card-patient-${patient.uid}`}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <Avatar>
                            <AvatarFallback className="bg-primary text-primary-foreground">
                              {getInitials(patient.displayName)}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <h3 className="text-lg font-semibold">{patient.displayName}</h3>
                            <p className="text-sm text-muted-foreground">{patient.email}</p>
                          </div>
                        </div>
                        <Badge variant="outline">Patient</Badge>
                      </div>
                      
                      <div className="grid grid-cols-3 gap-2 text-center mb-4">
                        <div>
                          <p className="text-2xl font-bold">{patient.totalExercises}</p>
                          <p className="text-xs text-muted-foreground">Exercises</p>
                        </div>
                        <div>
                          <p className="text-2xl font-bold">{patient.completedExercises}</p>
                          <p className="text-xs text-muted-foreground">Completed</p>
                        </div>
                        <div>
                          <p className="text-2xl font-bold">-</p>
                          <p className="text-xs text-muted-foreground">Last Active</p>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          className="flex-1"
                          size="sm"
                          data-testid={`button-view-${patient.uid}`}
                          onClick={() => {
                            setSelectedPatient(patient);
                            setViewDialogOpen(true);
                          }}
                        >
                          <Eye className="w-4 h-4 mr-1" />
                          View
                        </Button>
                        {userProfile && (
                          <AssignExerciseDialog
                            physioId={userProfile.uid}
                            patientId={patient.uid}
                            patientName={patient.displayName}
                            onExerciseAssigned={loadPatients}
                          />
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Patient Detail Dialog */}
      {selectedPatient && (
        <PatientDetailDialog
          patient={selectedPatient}
          open={viewDialogOpen}
          onOpenChange={setViewDialogOpen}
        />
      )}
    </div>
  );
}
