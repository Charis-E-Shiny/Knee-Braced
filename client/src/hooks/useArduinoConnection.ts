import { useState, useCallback, useRef, useEffect } from "react";
import { collection, addDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { InsertReading } from "@shared/schema";

interface ArduinoReading {
  angle: number;
  roll: number;
  pitch: number;
  yaw: number;
  raw: string;
}

export function useArduinoConnection(patientId: string) {
  const [connected, setConnected] = useState(false);
  const [deviceName, setDeviceName] = useState<string>();
  const [currentReading, setCurrentReading] = useState<ArduinoReading | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const currentExerciseIdRef = useRef<string | undefined>();
  const isRecordingRef = useRef(false);

  // Keep refs in sync with state
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // ✅ Parse Arduino serial line
  const parseSerialLine = (line: string): ArduinoReading | null => {
    const angleMatch = line.match(/Angle:\s*([\d.]+)/);
    const rollMatch = line.match(/Roll:\s*([\d.-]+)/);
    const pitchMatch = line.match(/Pitch:\s*([\d.-]+)/);
    const yawMatch = line.match(/Yaw:\s*([\d.-]+)/);

    if (angleMatch && rollMatch && pitchMatch && yawMatch) {
      return {
        angle: parseFloat(angleMatch[1]),
        roll: parseFloat(rollMatch[1]),
        pitch: parseFloat(pitchMatch[1]),
        yaw: parseFloat(yawMatch[1]),
        raw: line,
      };
    }
    return null;
  };

  // ✅ Save reading locally and send to n8n
  const saveReading = useCallback(
    async (reading: ArduinoReading) => {
      try {
        const exerciseId = currentExerciseIdRef.current ?? "unassigned";

        const readingData: InsertReading = {
          patientId,
          timestamp: Date.now(),
          angle: reading.angle,
          roll: reading.roll,
          pitch: reading.pitch,
          yaw: reading.yaw,
          raw: reading.raw,
          exerciseId,
          sentToN8N: false,
        };

        const collectionRef = collection(db, "readings");
        const readingDocRef = await addDoc(collectionRef, readingData);
        console.log("✅ Saved reading:", readingData);

        // 🔗 Send to n8n webhook
        try {
          const n8nRes = await fetch("https://hackgroup.app.n8n.cloud/webhook/patient-query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(readingData),
          });

          const status = n8nRes.status;
          const n8nData = await n8nRes.json().catch(() => ({}));

          console.log("🤖 n8n Response:", n8nData);

          await updateDoc(readingDocRef, {
            sentToN8N: true,
            n8nStatusCode: status,
            n8nResponse: JSON.stringify(n8nData),
          });

          // Optionally store recommendations for patient
          if (Array.isArray(n8nData) && n8nData[0]?.recommendations) {
            const patientRef = collection(db, "patients", patientId, "n8nResponses");
            await addDoc(patientRef, {
              timestamp: Date.now(),
              recommendations: n8nData[0].recommendations,
            });
          }
        } catch (err) {
          console.error("❌ Error sending to n8n:", err);
        }
      } catch (error) {
        console.error("❌ Error preparing reading:", error);
      }
    },
    [patientId]
  );

  // ✅ Connect to Arduino device
  const connect = useCallback(async () => {
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 9600 });
      portRef.current = port;
      setConnected(true);
      setDeviceName("Arduino Device");

      if (!port.readable) throw new Error("Serial port not readable");

      const decoder = new TextDecoderStream();
      const reader = decoder.readable.getReader();
      const writable = decoder.writable as WritableStream<Uint8Array>;
      const readableStreamClosed = (port.readable as ReadableStream<Uint8Array>).pipeTo(writable);
      readerRef.current = reader;

      console.log("🔌 Connected to Arduino.");

      let buffer = "";

      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;

            buffer += value;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed) {
                const reading = parseSerialLine(trimmed);
                if (reading) {
                  setCurrentReading(reading);
                  if (isRecordingRef.current) {
                    saveReading(reading);
                  }
                }
              }
            }
          }
        } catch (error) {
          console.error("❌ Error in read loop:", error);
        }
      })();

      await readableStreamClosed.catch(() => {});
    } catch (error) {
      console.error("⚠️ Error connecting to Arduino:", error);
      setConnected(false);
    }
  }, [saveReading]);

  // ✅ Disconnect from Arduino
  const disconnect = useCallback(async () => {
    try {
      if (readerRef.current) {
        await readerRef.current.cancel();
        readerRef.current = null;
      }

      if (portRef.current) {
        await portRef.current.close();
        portRef.current = null;
      }

      setConnected(false);
      setDeviceName(undefined);
      setCurrentReading(null);
      console.log("🔌 Disconnected from Arduino.");
    } catch (error) {
      console.error("❌ Error disconnecting:", error);
    }
  }, []);

  // ✅ Start recording (can request exercise ID from n8n or use given one)
  const startRecording = useCallback(
    async (exerciseId?: string) => {
      console.log("▶️ Starting recording...");

      try {
        if (exerciseId) {
          currentExerciseIdRef.current = exerciseId;
          setIsRecording(true);
          console.log("Recording for exercise:", exerciseId);
          return;
        }

        const res = await fetch("https://hackgroup.app.n8n.cloud/webhook/patient-query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patientId }),
        });

        const data = await res.json();
        const generatedId = data.exerciseId || "manual-" + Date.now();

        currentExerciseIdRef.current = generatedId;
        setIsRecording(true);
        console.log("Got exerciseId from n8n:", generatedId);
      } catch (error) {
        console.error("❌ Failed to get exercise ID from n8n:", error);
        currentExerciseIdRef.current = "unknown";
        setIsRecording(true);
      }
    },
    [patientId]
  );

  // ✅ Stop recording
  const stopRecording = useCallback(() => {
    console.log("⏹️ Recording stopped");
    setIsRecording(false);
    currentExerciseIdRef.current = undefined;
  }, []);

  return {
    connected,
    deviceName,
    currentReading,
    isRecording,
    connect,
    disconnect,
    startRecording,
    stopRecording,
  };
}
