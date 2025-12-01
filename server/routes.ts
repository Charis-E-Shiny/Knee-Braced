import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import fetch from "node-fetch";
import { storage } from "./storage";

async function safeParseJSON(response: any) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text }; // 👈 prevents crashes
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", message: "Server is running 🚀" });
  });

  app.get("/api/users", async (_req: Request, res: Response) => {
    try {
      const users = await storage.getAllUsers?.();
      res.json(users || []);
    } catch (error) {
      console.error("❌ Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // 🟢 Main n8n forwarder (NO CRASHES)
  app.post("/api/n8n/patient-query", async (req: Request, res: Response) => {
    try {
      const response = await fetch(
        "https://hack12.app.n8n.cloud/webhook/patient-query",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
        }
      );

      const data = await safeParseJSON(response); // 👈 FIX

      res.status(response.status).json({
        status: response.status,
        ok: response.ok,
        data,
      });
    } catch (error) {
      console.error("❌ Error forwarding to n8n:", error);
      res.status(500).json({
        error: "Failed to reach n8n webhook",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 🧪 Same fix for test webhook
  app.post("/api/n8n/patient-query", async (req: Request, res: Response) => {
    try {
      const response = await fetch(
        "https://hack12.app.n8n.cloud/webhook/patient-query",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
        }
      );

      const data = await safeParseJSON(response);

      res.status(response.status).json({
        status: response.status,
        ok: response.ok,
        data,
      });
    } catch (error) {
      console.error("❌ Error contacting n8n test webhook:", error);
      res.status(500).json({
        error: "Failed to reach n8n test webhook",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const httpServer = createServer(app);
  console.log("✅ Routes registered successfully");
  return httpServer;
}
