import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { getExercisesByCreator, assignExerciseToPatient } from "@/lib/firestore";
import { collection, query, where, getDocs, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Plus } from "lucide-react";
import type { Exercise, InsertAssignedExercise } from "@shared/schema";

interface AssignExerciseDialogProps {
  physioId: string;
  patientId: string;
  patientName: string;
  onExerciseAssigned: () => void;
}

export function AssignExerciseDialog({
  physioId,
  patientId,
  patientName,
  onExerciseAssigned,
}: AssignExerciseDialogProps) {
  const [open, setOpen] = useState(false);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [selectedExerciseId, setSelectedExerciseId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [loadingExercises, setLoadingExercises] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (open && physioId) {
      loadExercises();
    }
  }, [open, physioId]);

  const loadExercises = async () => {
    if (!physioId) {
      toast({
        title: "Error",
        description: "Physiotherapist ID is missing",
        variant: "destructive",
      });
      return;
    }

    setLoadingExercises(true);
    setExercises([]); // Clear previous exercises
    try {
      // Try the helper function first
      let exerciseList = await getExercisesByCreator(physioId);
      console.log("Loaded exercises for physio", physioId, ":", exerciseList);
      
      // If no exercises found, try a direct query without orderBy as fallback
      if (exerciseList.length === 0) {
        console.log("No exercises from helper, trying direct query...");
        const q = query(
          collection(db, "exercises"),
          where("createdBy", "==", physioId)
        );
        const snapshot = await getDocs(q);
        exerciseList = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Exercise[];
        console.log("Direct query result:", exerciseList);
      }
      
      setExercises(exerciseList);
      if (exerciseList.length === 0) {
        console.warn("No exercises found for physio:", physioId);
      }
    } catch (error: any) {
      console.error("Error loading exercises:", error);
      console.error("Error details:", {
        code: error.code,
        message: error.message,
        physioId,
      });
      
      // Try fallback query without orderBy
      try {
        console.log("Trying fallback query without orderBy...");
        const q = query(
          collection(db, "exercises"),
          where("createdBy", "==", physioId)
        );
        const snapshot = await getDocs(q);
        const fallbackExercises = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Exercise[];
        console.log("Fallback query result:", fallbackExercises);
        setExercises(fallbackExercises);
      } catch (fallbackError: any) {
        console.error("Fallback query also failed:", fallbackError);
        toast({
          title: "Error loading exercises",
          description: fallbackError.message || "Could not load exercises. Please check console for details.",
          variant: "destructive",
        });
      }
    } finally {
      setLoadingExercises(false);
    }
  };

  const handleAssign = async () => {
    if (!selectedExerciseId) {
      toast({
        title: "Exercise required",
        description: "Please select an exercise to assign",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);

    try {
      const exercise = exercises.find((e) => e.id === selectedExerciseId);
      if (!exercise) return;

      const assignmentData: InsertAssignedExercise = {
        exerciseId: exercise.id,
        exerciseName: exercise.name,
        patientId: patientId,
        assignedBy: physioId,
        targetAngleMin: exercise.targetAngleMin,
        targetAngleMax: exercise.targetAngleMax,
        targetReps: exercise.targetReps,
        targetDuration: exercise.targetDuration,
      };

      await assignExerciseToPatient(patientId, assignmentData);

      toast({
        title: "Exercise assigned",
        description: `${exercise.name} assigned to ${patientName}`,
      });

      setSelectedExerciseId("");
      setOpen(false);
      onExerciseAssigned();
    } catch (error: any) {
      toast({
        title: "Assignment failed",
        description: error.message || "Could not assign exercise",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" size="sm" data-testid={`button-assign-${patientId}`}>
          <Plus className="w-4 h-4 mr-1" />
          Assign
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign Exercise</DialogTitle>
          <DialogDescription>
            Select an exercise to assign to {patientName}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {loadingExercises ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
              <span className="ml-2 text-sm text-muted-foreground">Loading exercises...</span>
            </div>
          ) : exercises.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No exercises available. Create an exercise template first.
            </p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="exercise-select">Exercise</Label>
              <Select value={selectedExerciseId} onValueChange={setSelectedExerciseId}>
                <SelectTrigger id="exercise-select" data-testid="select-exercise">
                  <SelectValue placeholder="Select an exercise" />
                </SelectTrigger>
                <SelectContent>
                  {exercises.map((exercise) => (
                    <SelectItem key={exercise.id} value={exercise.id}>
                      {exercise.name} ({exercise.targetReps} reps, {exercise.targetAngleMin}°-
                      {exercise.targetAngleMax}°)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-3">
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            data-testid="button-cancel-assign-exercise"
          >
            Cancel
          </Button>
          <Button
            onClick={handleAssign}
            disabled={loading || !selectedExerciseId}
            data-testid="button-confirm-assign-exercise"
          >
            {loading ? "Assigning..." : "Assign Exercise"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
