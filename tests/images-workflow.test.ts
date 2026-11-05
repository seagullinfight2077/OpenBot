import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
};
type Job = {
  "runs-on": string;
  needs?: string | string[];
  strategy?: {
    matrix?: { platform?: Array<{ arch: string; runner: string }> };
  };
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
};

const workflow = parse(
  readFileSync(
    join(import.meta.dir, "..", ".github", "workflows", "images.yml"),
    "utf8",
  ),
) as { jobs: Record<string, Job> };

// The workflow names its registry from the repository it runs in, so a fork publishes to its own.
// biome-ignore lint/suspicious/noTemplateCurlyInString: this is the workflow's literal expression, unexpanded.
const OPENBOT = "${{ needs.components.outputs.repository }}";
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The machines are laptops as well as servers: arm64 Macs and amd64 everything else. Native runners
// for each, never QEMU, for the reason the workflow gives on `component-images`.
const NATIVE_PLATFORMS = [
  { arch: "amd64", runner: "ubuntu-latest" },
  { arch: "arm64", runner: "ubuntu-24.04-arm" },
];

const isBuild = (step: Step) =>
  step.uses?.startsWith("docker/build-push-action@") ?? false;
const needsOf = (job: Job) => [job.needs ?? []].flat();

/** The jobs that push an image, with the build step of each. */
function buildJobs(): Array<{ name: string; job: Job; build: Step }> {
  return Object.entries(workflow.jobs).flatMap(([name, job]) =>
    (job.steps ?? []).filter(isBuild).map((build) => ({ name, job, build })),
  );
}

/** The all-in-one image's builds: pushed to the repository itself, not `<repository>-<service>`. */
function pushesOpenbot(build: Step): boolean {
  const target = `${build.with?.outputs ?? ""}\n${build.with?.tags ?? ""}`;
  return new RegExp(`${escapeRegExp(OPENBOT)}(?![-\\w])`).test(target);
}

/** The job that writes tags over both architectures of the all-in-one image. */
function openbotListJob(): [string, Job] | undefined {
  return Object.entries(workflow.jobs).find(([, job]) =>
    (job.steps ?? []).some(
      (step) =>
        step.run?.includes("docker buildx imagetools create") &&
        step.env?.REPOSITORY === OPENBOT,
    ),
  );
}

describe("images.yml", () => {
  test("the all-in-one openbot image is one of the images it builds", () => {
    expect(buildJobs().some(({ build }) => pushesOpenbot(build))).toBe(true);
  });

  test("every image it pushes is built on a native runner of each architecture", () => {
    for (const { name, job, build } of buildJobs()) {
      expect({ name, platforms: job.strategy?.matrix?.platform }).toEqual({
        name,
        platforms: NATIVE_PLATFORMS,
      });
      expect({ name, runsOn: job["runs-on"] }).toEqual({
        name,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the unexpanded Actions expression is what is asserted.
        runsOn: "${{ matrix.platform.runner }}",
      });
      expect({ name, platforms: build.with?.platforms }).toEqual({
        name,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the unexpanded Actions expression is what is asserted.
        platforms: "linux/${{ matrix.platform.arch }}",
      });
    }
  });

  // A tag written by one architecture's leg would name that architecture, and the two legs would
  // race to own it.
  test("a build leg pushes by digest and writes no tags", () => {
    for (const { name, build } of buildJobs()) {
      expect({ name, tags: build.with?.tags }).toEqual({
        name,
        tags: undefined,
      });
      expect({ name, outputs: build.with?.outputs }).toEqual({
        name,
        outputs: expect.stringContaining("push-by-digest=true"),
      });
    }
  });

  test("the caller's tags are written once over both architectures, and the manifest pins that list", () => {
    const list = openbotListJob();
    expect(list).toBeDefined();
    const [listName, listJob] = list as [string, Job];

    const merge = (listJob.steps ?? []).find((step) =>
      step.run?.includes("imagetools create"),
    ) as Step;
    // The same tag list every component image gets, so `sha-<commit>`, a release's version and
    // `latest` all land on the list rather than on one architecture.
    expect(merge.env?.TAGS).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the unexpanded Actions expression is what is asserted.
      "${{ needs.components.outputs.tags }}",
    );
    expect(merge.run).toMatch(/for arch in amd64 arm64\b/);

    // The attestation and the manifest both name the list, so `gh attestation verify` on a tag and
    // a deploy by digest refer to the same thing.
    const attest = (listJob.steps ?? []).find((step) =>
      step.uses?.startsWith("actions/attest-build-provenance@"),
    ) as Step;
    expect(attest.with?.["subject-name"]).toBe(OPENBOT);
    expect(attest.with?.["subject-digest"]).toBe(
      `\${{ steps.${merge.id}.outputs.digest }}`,
    );
    expect(listJob.outputs?.digest).toBe(
      `\${{ steps.${merge.id}.outputs.digest }}`,
    );

    const manifest = workflow.jobs.manifest as Job;
    expect(needsOf(manifest)).toContain(listName);
    const write = (manifest.steps ?? []).find(
      (step) => step.name === "Write the image manifest",
    ) as Step;
    expect(write.env?.DIGEST).toBe(`\${{ needs.${listName}.outputs.digest }}`);
  });

  // The digests travel as artifacts, so a name that differs by one character between upload and
  // download, or a list job that does not wait for the builds, fails only on release day.
  test("the list job waits for the builds and downloads exactly what they upload", () => {
    const [listName, listJob] = openbotListJob() as [string, Job];
    const builds = buildJobs().filter(({ build }) => pushesOpenbot(build));
    expect(builds.length).toBe(1);
    const { name: buildName, job: buildJob } = builds[0] as (typeof builds)[0];
    expect(needsOf(listJob)).toContain(buildName);

    const uploaded = (buildJob.steps ?? [])
      .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
      .flatMap((step) =>
        NATIVE_PLATFORMS.map(({ arch }) =>
          String(step.with?.name).replace(
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the unexpanded Actions expression is what is replaced.
            "${{ matrix.platform.arch }}",
            arch,
          ),
        ),
      );
    const downloaded = (listJob.steps ?? [])
      .filter((step) => step.uses?.startsWith("actions/download-artifact@"))
      .map((step) => String(step.with?.name));
    expect(downloaded.sort()).toEqual(uploaded.sort());
    expect(downloaded.length).toBe(NATIVE_PLATFORMS.length);

    // Pushing the list and signing its attestation need all three.
    expect({ job: listName, permissions: listJob.permissions }).toEqual({
      job: listName,
      permissions: expect.objectContaining({
        packages: "write",
        "id-token": "write",
        attestations: "write",
      }),
    });
  });

  // `manifest` counts `manifest-*` artifacts against the component list and refuses to write the
  // file if the numbers differ, so the openbot image must not add one.
  test("the openbot image's artifacts stay out of the component manifest count", () => {
    const openbotJobs = new Set([
      ...buildJobs()
        .filter(({ build }) => pushesOpenbot(build))
        .map(({ name }) => name),
      ...(openbotListJob()?.slice(0, 1) ?? []),
    ] as string[]);
    for (const name of openbotJobs) {
      const uploads = ((workflow.jobs[name] as Job).steps ?? [])
        .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
        .map((step) => String(step.with?.name));
      for (const upload of uploads) {
        expect(upload).not.toMatch(/^manifest-/);
      }
    }
  });
});
