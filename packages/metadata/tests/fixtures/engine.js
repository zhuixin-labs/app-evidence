// Writes controlled results only; this is not a package analyzer.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { createStore } = require(process.env.APPTRACE_FIXTURE_METADATA);
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  const store = createStore(path.join(request.workspacePath, "workbench.sqlite"));
  const job = store.getJob(request.input.jobId);
  if (request.capability === "inspect:ipa") {
    const artifact = store.listArtifacts(request.targetId).find(item => item.id === request.artifactId);
    store.insertArtifact({ ...artifact, inspection: { fixture: true } });
  }
  const result = request.capability === "generate:report" ? { reportPath: "fixture-report.md" } : { fixture: true };
  store.upsertJob({ ...job, status: "analyzed", result, finishedAt: new Date().toISOString() });
  store.close();
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
});
