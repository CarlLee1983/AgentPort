#!/usr/bin/env node
import { doctor, DoctorError } from "./doctor.js";

function write(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[2] !== "doctor") {
  write({ version: 1, code: "agentport_arguments_invalid" });
  process.exitCode = 2;
} else {
  try {
    write(await doctor(process.argv.slice(3)));
  } catch (error) {
    write({
      version: 1,
      code: error instanceof DoctorError ? error.code : "doctor_unavailable",
    });
    process.exitCode = 2;
  }
}
