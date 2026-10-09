/**
 * Site-copy guard: the canonical strings in src/helpers/copy.ts must be what
 * the shipped surfaces actually say, and retired wording must stay gone.
 * Extend this as each copy PR lands; it is what stops an upstream merge from
 * quietly reverting the text.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import * as COPY from "../helpers/copy";
import { SITE_DESCRIPTION, SITE_TITLE } from "../helpers/copy";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

/** Every shipped source file under src/ — tests excluded, they quote retired
 *  phrases in negative assertions. */
const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "test") walk(full);
      } else if (/\.(tsx?|css|html)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push(full);
      }
    }
  };
  walk(resolve(process.cwd(), "src"));
  return out;
};

/** Wording that was deliberately replaced; a hit means a merge brought it back. */
const RETIRED_PHRASES = [
  "A CT Segmentation Platform",
  "For commercial use, please visit",
  "By continuing you agree to our",
  "Draft placeholder",
  "not yet in force",
  "never used to identify you personally",
  "deleted automatically after the retention period",
  "Signed BAA and DPA",
  "PACS integration",
  "Donate for Pro",
  "monthly donation",
  "For everyday clinical",
  "See donation options",
  "permanently deletes every scan",
  "30 days to change your mind",
  "open library of labeled body CT scans",
  "BodyMaps — the intelligence layer",
  // The page is the Privacy Notice; the sign-in fine print called it this.
  "Privacy Policy",
];

describe("site copy guard", () => {
  it("index.html title and descriptions match the canonical copy", () => {
    const html = read("index.html");
    expect(html).toContain(`<title>${SITE_TITLE}</title>`);
    expect(html).toContain(`property="og:title" content="${SITE_TITLE}"`);
    expect(html).toContain(`name="twitter:title" content="${SITE_TITLE}"`);
    for (const attr of [
      'name="description"',
      'property="og:description"',
      'name="twitter:description"',
    ]) {
      expect(html).toContain(`${attr} content="${SITE_DESCRIPTION}"`);
    }
  });

  it("canonical strings follow the copy rules: no em dash, no spaced hyphen", () => {
    for (const [name, value] of Object.entries(COPY)) {
      if (typeof value !== "string") continue;
      expect(value, name).not.toMatch(/\u2014/);
      expect(value, name).not.toMatch(/ - /);
    }
  });

  it("retired wording does not come back anywhere in src/ or index.html", () => {
    const files = [...sourceFiles(), resolve(process.cwd(), "index.html")];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const phrase of RETIRED_PHRASES) {
        expect(text, `${file} contains retired phrase "${phrase}"`).not.toContain(phrase);
      }
    }
  });
});
