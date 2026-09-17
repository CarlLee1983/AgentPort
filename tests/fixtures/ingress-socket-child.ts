import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { RuntimeWorkerIngress } from "../../src/runtime/worker/ingress.js";

/**
 * Opens one production RuntimeWorkerIngress as the non-root daemon account,
 * spawned by `tests/linux/runtime-isolation.test.ts` via `runuser` (AP-021
 * R4). It prints only the endpoint path and process uid, never the token, and
 * keeps the socket open until the parent closes stdin.
 */

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the ingress socket child`);
  }
  return value;
}

async function main(): Promise<void> {
  const [ingressDirectory, runtimeGroup] = process.argv.slice(2);
  const endpoint = join(
    required(ingressDirectory, "ingress directory"),
    `${randomUUID()}.sock`,
  );
  const unused = () => Promise.reject(new Error("unused"));
  const ingress = await RuntimeWorkerIngress.open({
    endpoint,
    reference: {
      executionId: `execution-${randomUUID()}`,
      generation: `generation-${randomUUID()}`,
      daemonEpoch: "epoch-ingress-socket-child",
      launchProfileId: "g1-idle",
      workspaceIdentity: "g1-workspace",
    },
    lifecycle: {
      persistQuestion: unused,
      waitForAcceptedAnswer: unused,
      acknowledgeQuestionDelivery: unused,
      markQuestionDeliveryUnknown: unused,
      recordObservation: unused,
      stopAfterCandidate: unused,
      quarantine: unused,
    },
    groupId: Number(required(runtimeGroup, "Runtime group id")),
  });
  process.stdout.write(
    `${JSON.stringify({ endpoint, processUid: process.getuid?.() ?? -1 })}\n`,
  );
  process.stdin.resume();
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
  });
  await ingress.close();
}

main().catch(() => {
  process.exitCode = 1;
});
