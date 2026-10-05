import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../dist/cliplab/", import.meta.url);
await mkdir(destination, { recursive: true });
await Promise.all(["LICENSE", "PROVENANCE.md"].map((name) =>
  copyFile(new URL(`../src/cliplab/${name}`, import.meta.url), new URL(name, destination)),
));
