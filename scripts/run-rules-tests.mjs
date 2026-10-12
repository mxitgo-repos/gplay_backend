#!/usr/bin/env node
/**
 * Runs the firestore.rules test suite against the Firestore emulator.
 *
 * The only interesting thing here is Java. The emulator is a Java program, and
 * macOS ships no JDK — but this is a Flutter shop, so Android Studio's bundled
 * JBR is already on every machine that can build the Android app. Falling back
 * to it beats asking everyone to install a second JDK just to run rules tests.
 *
 * Resolution order: JAVA_HOME -> java already on PATH -> Android Studio's JBR.
 */
import {spawnSync, spawnSync as run} from "node:child_process";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {homedir} from "node:os";

const CANDIDATE_JDKS = [
  "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
  join(homedir(), "Applications/Android Studio.app/Contents/jbr/Contents/Home"),
  "/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home",
];

function javaOnPath() {
  return run("java", ["-version"], {stdio: "ignore"}).status === 0;
}

function resolveJavaHome() {
  if (process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, "bin", "java"))) {
    return process.env.JAVA_HOME;
  }
  if (javaOnPath()) return null; // already usable, nothing to inject
  return CANDIDATE_JDKS.find((home) => existsSync(join(home, "bin", "java"))) ?? null;
}

const env = {...process.env};
const javaHome = resolveJavaHome();

if (javaHome) {
  env.JAVA_HOME = javaHome;
  env.PATH = `${join(javaHome, "bin")}:${env.PATH}`;
  console.log(`[rules-tests] using JDK at ${javaHome}`);
} else if (!javaOnPath()) {
  console.error(
    "[rules-tests] No JDK found.\n" +
    "  The Firestore emulator needs Java 11+. Either install one (brew install --cask temurin),\n" +
    "  set JAVA_HOME, or install Android Studio (its bundled JBR is picked up automatically).",
  );
  process.exit(1);
}

// Prefer a `firebase` already on PATH (the CI images and this repo's docs both
// assume a global firebase-tools); fall back to npx, which resolves the package
// name `firebase-tools`, NOT `firebase` — `npx firebase` fetches an unrelated
// package and fails with "could not determine executable to run".
const hasGlobalFirebase = run("firebase", ["--version"], {stdio: "ignore", env}).status === 0;
const [cmd, leadingArgs] = hasGlobalFirebase
  ? ["firebase", []]
  : ["npx", ["--yes", "firebase-tools"]];

const watch = process.argv.includes("--watch");
// The functions suite (B4 cascade) needs triggers running, so it starts the
// functions emulator too and takes ~30s longer. The rules suite deliberately
// does not, so the post-edit loop stays fast.
const withFunctions = process.argv.includes("--functions");

const emulators = withFunctions ? "firestore,functions" : "firestore";
const vitestArgs = withFunctions
  ? "vitest run --config vitest.functions.config.js"
  : (watch ? "vitest" : "vitest run");

const result = spawnSync(
  cmd,
  [
    ...leadingArgs,
    "emulators:exec",
    "--only", emulators,
    "--project", "gplay-rules-test",
    vitestArgs,
  ],
  {stdio: "inherit", env},
);

process.exit(result.status ?? 1);
