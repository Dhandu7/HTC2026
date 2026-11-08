// Starts Electron against the running Vite dev server (cross-platform env handling).
import { spawn } from "node:child_process";
import electron from "electron";

const url = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";
const child = spawn(electron, [".", ...(process.env.GAZETYPE_DEBUG_PORT ? [`--remote-debugging-port=${process.env.GAZETYPE_DEBUG_PORT}`] : [])], { stdio: "inherit", env: { ...process.env, VITE_DEV_SERVER_URL: url } });
child.on("exit", (code) => process.exit(code ?? 0));
