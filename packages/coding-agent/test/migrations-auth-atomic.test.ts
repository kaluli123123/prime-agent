import { existsSync, mkdirSync, mkdtempSync, readFileSync, type renameSync, rmSync, type writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type RenameSync = typeof renameSync;
type WriteFileSync = typeof writeFileSync;

const fsMocks = vi.hoisted(() => ({
	actualRenameSync: undefined as RenameSync | undefined,
	actualWriteFileSync: undefined as WriteFileSync | undefined,
	renameSync: vi.fn<RenameSync>(),
	writeFileSync: vi.fn<WriteFileSync>(),
	callOrder: [] as string[],
}));
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	fsMocks.actualRenameSync = actual.renameSync;
	fsMocks.actualWriteFileSync = actual.writeFileSync;
	fsMocks.renameSync.mockImplementation((...args: Parameters<RenameSync>) => {
		fsMocks.callOrder.push(`rename:${String(args[0])}->${String(args[1])}`);
		return actual.renameSync(...args);
	});
	fsMocks.writeFileSync.mockImplementation((...args: Parameters<WriteFileSync>) => {
		fsMocks.callOrder.push(`write:${String(args[0])}`);
		return actual.writeFileSync(...args);
	});
	return {
		...actual,
		renameSync: fsMocks.renameSync,
		writeFileSync: fsMocks.writeFileSync,
	};
});

const { ENV_AGENT_DIR } = await import("../src/config.js");
const { migrateAuthToAuthJson } = await import("../src/migrations.js");

describe("migrateAuthToAuthJson write ordering (#983)", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		fsMocks.renameSync.mockClear();
		fsMocks.writeFileSync.mockClear();
		fsMocks.callOrder.length = 0;
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function setupAgentDir(options: { oauth?: Record<string, unknown>; apiKeys?: Record<string, string> } = {}) {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-auth-migration-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;
		mkdirSync(agentDir, { recursive: true });
		if (options.oauth) {
			fsMocks.actualWriteFileSync!(join(agentDir, "oauth.json"), JSON.stringify(options.oauth));
		}
		if (options.apiKeys) {
			fsMocks.actualWriteFileSync!(
				join(agentDir, "settings.json"),
				JSON.stringify({ theme: "dark", apiKeys: options.apiKeys }),
			);
		}
		return agentDir;
	}

	it("migrates oauth.json credentials and settings.json apiKeys into auth.json, then cleans up sources", () => {
		const agentDir = setupAgentDir({
			oauth: { anthropic: { access: "tok", refresh: "r" } },
			apiKeys: { openai: "sk-openai" },
		});

		const providers = migrateAuthToAuthJson();

		expect(providers.sort()).toEqual(["anthropic", "openai"]);
		const authJson = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
		expect(authJson).toMatchObject({
			anthropic: { type: "oauth", access: "tok", refresh: "r" },
			openai: { type: "api_key", key: "sk-openai" },
		});
		expect(existsSync(join(agentDir, "oauth.json"))).toBe(false);
		expect(existsSync(join(agentDir, "oauth.json.migrated"))).toBe(true);
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(settings).toEqual({ theme: "dark" });
	});

	it("writes auth.json durably before touching either legacy source", () => {
		setupAgentDir({
			oauth: { anthropic: { access: "tok", refresh: "r" } },
			apiKeys: { openai: "sk-openai" },
		});

		migrateAuthToAuthJson();

		const authRenameIndex = fsMocks.callOrder.findIndex(
			(entry) => entry.startsWith("rename:") && entry.includes("auth.json") && !entry.includes("oauth"),
		);
		const oauthRenameIndex = fsMocks.callOrder.findIndex(
			(entry) => entry.startsWith("rename:") && entry.includes("oauth.json") && entry.includes("migrated"),
		);
		const settingsWriteIndex = fsMocks.callOrder.findIndex(
			(entry) => entry.startsWith("write:") && entry.includes("settings.json") && !entry.includes(".tmp"),
		);

		expect(authRenameIndex).toBeGreaterThanOrEqual(0);
		expect(oauthRenameIndex).toBeGreaterThan(authRenameIndex);
		expect(settingsWriteIndex).toBeGreaterThan(authRenameIndex);
	});

	it("keeps the migrated auth.json intact even if cleaning up a legacy source fails", () => {
		const agentDir = setupAgentDir({
			oauth: { anthropic: { access: "tok", refresh: "r" } },
		});

		fsMocks.renameSync.mockImplementation((...args: Parameters<RenameSync>) => {
			if (String(args[1]).endsWith("oauth.json.migrated")) {
				throw new Error("simulated crash before oauth.json cleanup");
			}
			return fsMocks.actualRenameSync!(...args);
		});

		expect(() => migrateAuthToAuthJson()).not.toThrow();

		// auth.json already holds the full migrated data regardless of whether the
		// (non-essential, best-effort) source cleanup afterward succeeded.
		const authJson = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
		expect(authJson).toMatchObject({ anthropic: { type: "oauth", access: "tok", refresh: "r" } });
	});

	it("is a no-op once auth.json exists, so a retried run cannot lose already-migrated data", () => {
		const agentDir = setupAgentDir({ oauth: { anthropic: { access: "tok", refresh: "r" } } });
		migrateAuthToAuthJson();
		const firstRunContent = readFileSync(join(agentDir, "auth.json"), "utf-8");

		const providers = migrateAuthToAuthJson();

		expect(providers).toEqual([]);
		expect(readFileSync(join(agentDir, "auth.json"), "utf-8")).toBe(firstRunContent);
	});
});
