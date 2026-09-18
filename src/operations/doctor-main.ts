import { doctor, DoctorError } from "./doctor.js";

function safeCode(error: unknown): string {
  return error instanceof DoctorError ? error.code : "doctor_unavailable";
}

try {
  process.stdout.write(
    `${JSON.stringify(await doctor(process.argv.slice(2)))}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ version: 1, code: safeCode(error) })}\n`,
  );
  process.exitCode = 2;
}
