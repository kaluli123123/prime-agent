import { existsSync, mkdirSync, readdirSync, readFileSync, type renameSync, rmSync, type writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type RenameSync = typeof renameSync;
type WriteFileSync = typeof writeFileSync;

const fsMocks = vi.hoisted(() => ({
	renameSync: vi.fn<RenameSync>(),
	writeFileSync: vi.fn<WriteFileSync>(),
}));
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	fsMocks.renameSync.mockImplementation(actual.renameSync);
	fsMocks.writeFileSync.mockImplementation(actual.writeFileSync);
	return {
		...actual,
		renameSync: fsMocks.renameSync,
		writeFileSync: fsMocks.writeFileSync,
	};
});

const { FileAuthStorageBackend } = await import("../src/core/auth-storage.js");

describe("FileAuthStorageBackend atomic writes (#983)", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		fsMocks.renameSync.mockClear();
		fsMocks.writeFileSync.mockClear();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop()!;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createAuthPath(): string {
		const dir = join(tmpdir(), `pi-test-auth-atomic-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return join(dir, "auth.json");
	}

	it("withLock writes via a temp file + rename instead of in place", () => {
		const authPath = createAuthPath();
		const backend = new FileAuthStorageBackend(authPath);
		fsMocks.renameSync.mockClear();
		fsMocks.writeFileSync.mockClear();

		backend.withLock((current) => {
			const base = current ? JSON.parse(current) : {};
			return { result: undefined, next: JSON.stringify({ ...base, anthropic: { type: "api_key", key: "sk-x" } }) };
		});

		// The auth path did not exist yet, so this also exercises
		// ensureFileExists()'s own atomic placeholder write ("{}") before the real
		// fn-driven write -- both must go through temp file + rename, never in place.
		expect(fsMocks.renameSync.mock.calls.length).toBeGreaterThanOrEqual(1);
		for (const [renameSource, renameDest] of fsMocks.renameSync.mock.calls) {
			expect(renameDest).toBe(authPath);
			expect(String(renameSource)).not.toBe(authPath);
			expect(dirname(String(renameSource))).toBe(dirname(authPath));
		}

		// writeFileSync must never target auth.json directly -- every call goes to
		// the temp path that gets renamed onto it.
		for (const call of fsMocks.writeFileSync.mock.calls) {
			expect(call[0]).not.toBe(authPath);
		}

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toMatchObject({
			anthropic: { type: "api_key", key: "sk-x" },
		});
		// No leftover temp file.
		expect(readdirSync(dirname(authPath)).filter((name) => name !== basename(authPath))).toEqual([]);
	});

	it("withLockAsync writes via a temp file + rename instead of in place", async () => {
		const authPath = createAuthPath();
		const backend = new FileAuthStorageBackend(authPath);
		fsMocks.renameSync.mockClear();
		fsMocks.writeFileSync.mockClear();

		await backend.withLockAsync(async (current) => {
			const base = current ? JSON.parse(current) : {};
			return {
				result: undefined,
				next: JSON.stringify({ ...base, openai: { type: "api_key", key: "sk-y" } }),
			};
		});

		expect(fsMocks.renameSync.mock.calls.length).toBeGreaterThanOrEqual(1);
		for (const [renameSource, renameDest] of fsMocks.renameSync.mock.calls) {
			expect(renameDest).toBe(authPath);
			expect(String(renameSource)).not.toBe(authPath);
		}

		for (const call of fsMocks.writeFileSync.mock.calls) {
			expect(call[0]).not.toBe(authPath);
		}

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toMatchObject({
			openai: { type: "api_key", key: "sk-y" },
		});
		expect(readdirSync(dirname(authPath)).filter((name) => name !== basename(authPath))).toEqual([]);
	});

	it("ensureFileExists (first touch) also writes the placeholder atomically", () => {
		const authPath = createAuthPath();
		expect(existsSync(authPath)).toBe(false);
		fsMocks.renameSync.mockClear();

		const backend = new FileAuthStorageBackend(authPath);
		backend.withLock((current) => ({ result: current, next: undefined }));

		expect(existsSync(authPath)).toBe(true);
		expect(fsMocks.renameSync).toHaveBeenCalled();
		for (const call of fsMocks.renameSync.mock.calls) {
			expect(call[1]).toBe(authPath);
		}
	});
});
