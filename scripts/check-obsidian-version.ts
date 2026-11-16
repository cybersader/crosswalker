import { readFileSync } from "node:fs";

const read = (name: string) => JSON.parse(readFileSync(name, "utf8"));
const manifest = read("manifest.json");
const pkg = read("package.json");
const versions = read("versions.json");
const version = manifest.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("manifest.version must be an Obsidian-compatible x.y.z version");
}
if (typeof manifest.minAppVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion)) {
  throw new Error("manifest.minAppVersion must be an x.y.z version");
}
if (pkg.version !== version || versions[version] !== manifest.minAppVersion) {
  throw new Error("package.json, manifest.json and versions.json must agree");
}
// Obsidian expects an exact version tag, without a leading v.
if (process.env.VERSION_TAG !== undefined && process.env.VERSION_TAG !== version) {
  throw new Error("The release tag must equal manifest.version exactly");
}
console.log(`Plugin version ${version} is consistent`);
