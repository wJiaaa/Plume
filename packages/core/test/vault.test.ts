/**
 * Secrets, and getting them out of the file everyone shares.
 *
 * The bug these are written against is not a crash: it is that `settings.json` held every API key
 * in plaintext at 0644, and that file is copied between machines and pasted into bug reports.
 *
 * Each test gets a home of its own. `plumeHome()` reads `PLUME_HOME` on every call, so pointing it
 * at a temporary directory is enough to isolate the whole of the config layer.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import { loadSettings, saveSettings, settingsPath, DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { resetVault, seal, unseal } from "../src/config/vault.ts";
import type { ProviderConfig, Settings } from "../src/types.ts";

let home: string;
const made: string[] = [];
const previous = { home: process.env.PLUME_HOME, userProfile: process.env.USERPROFILE };

/**
 * A profile of its own per test, not a shared one emptied between them.
 *
 * These write a key file, a credential store and a settings file, and the questions they ask are
 * about what is and is not in each. Sharing a directory made one test read a key another had
 * saved — which is a genuine behaviour (the vault wins over stale plaintext, and there is a test
 * for exactly that below) surfacing as a false failure somewhere it was not the subject.
 */
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "plume-vault-"));
	made.push(home);
	/*
	 * Both variables, because `os.homedir()` reads `USERPROFILE` on Windows and `HOME` elsewhere —
	 * a sandbox that sets only one of them leaks into the real profile on the other platform. This
	 * suite sets `PLUME_HOME` directly, which takes precedence over either, but the pair is set as
	 * well so nothing that falls back can reach outside.
	 */
	process.env.PLUME_HOME = home;
	process.env.USERPROFILE = home;
	// The vault caches its key and its file, and the next test's are different files entirely.
	resetVault();
});

after(async () => {
	if (previous.home === undefined) delete process.env.PLUME_HOME;
	else process.env.PLUME_HOME = previous.home;
	if (previous.userProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previous.userProfile;
	await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
});

function provider(id: string, apiKey: string): ProviderConfig {
	return { id, name: id, baseUrl: "https://example.invalid", api: "anthropic-messages", apiKey, enabled: true, models: [] };
}

/** Settings with providers, and nothing else worth asserting on. */
function withProviders(...providers: ProviderConfig[]): Settings {
	return { ...DEFAULT_SETTINGS, providers };
}

// ---------------------------------------------------------------------------
// The seal itself
// ---------------------------------------------------------------------------

test("a sealed secret comes back, and does not contain the plaintext", async () => {
	const sealed = await seal("sk-not-a-real-key");
	assert.ok(sealed.startsWith("v1:"), "sealed values carry the format tag unseal checks");
	assert.ok(!sealed.includes("sk-not-a-real-key"), "the plaintext is not sitting in the ciphertext");
	assert.equal(await unseal(sealed), "sk-not-a-real-key");
});

test("a value this key cannot open is null, not a throw", async () => {
	// Every caller turns failure into "enter it again"; a stack trace out of the decipher is not
	// something any of them could act on.
	assert.equal(await unseal("v1:bm90IGV2ZW4gY2xvc2U="), null);
	assert.equal(await unseal("plaintext from an older build"), null);
});

test("a key file that cannot be read is an error, and is never replaced", async (t) => {
	// chmod is not a read barrier on Windows, nor for root, who reads a 000 file regardless.
	if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("chmod 000 does not stop this reader");
	const sealed = await seal("sk-kept");
	const keyFile = join(home, "vault.key");
	const before = await readFile(keyFile);
	resetVault();
	await chmod(keyFile, 0o000);
	try {
		await assert.rejects(seal("sk-new"), /vault key/, "a read failure surfaces instead of minting a key");
		await assert.rejects(unseal(sealed), /vault key/, "not null: null means the secret is gone, and callers delete it");
	} finally {
		await chmod(keyFile, 0o600);
	}
	assert.deepEqual(await readFile(keyFile), before, "the key on disk is the one it was");
	assert.equal(await unseal(sealed), "sk-kept", "once readable again, the old secrets open");
});

test("a save made while the key could not be read does not delete the stored keys", async (t) => {
	if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("chmod 000 does not stop this reader");
	await saveSettings(withProviders(provider("p1", "sk-kept")));
	const keyFile = join(home, "vault.key");
	resetVault();
	await chmod(keyFile, 0o000);
	let loaded: Settings;
	try {
		loaded = await loadSettings();
	} finally {
		await chmod(keyFile, 0o600);
	}
	assert.equal(loaded.providers[0].apiKey, "", "the settings still load, without the key");
	// The desktop app saves the settings it holds on the next change, by which time the key reads.
	await saveSettings(loaded);
	resetVault();
	assert.equal((await loadSettings()).providers[0].apiKey, "sk-kept");
});

test("a key of the wrong length is moved aside, not overwritten", async () => {
	const keyFile = join(home, "vault.key");
	await writeFile(keyFile, "short");
	await seal("sk-one");
	const backups = (await readdir(home)).filter((name) => name.startsWith("vault.key.bad-"));
	assert.equal(backups.length, 1, `left: ${(await readdir(home)).join(", ")}`);
	assert.equal(await readFile(join(home, backups[0]), "utf8"), "short", "the old bytes are kept");
	assert.equal((await readFile(keyFile)).length, 32);
	assert.deepEqual((await readdir(home)).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left");
});

test("two processes using the vault for the first time end up with one key", async () => {
	// Each child seals a value against an empty home; every sealed value has to open with the key
	// that is on disk afterwards, or one process sealed with a key the other replaced.
	const script = `
		const { seal } = await import(${JSON.stringify(new URL("../src/config/vault.ts", import.meta.url).href)});
		process.stdout.write(await seal("sk-" + process.pid));
	`;
	const children = Array.from({ length: 4 }, () =>
		new Promise<string>((resolve, reject) => {
			execFile(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
				{ env: { ...process.env, PLUME_HOME: home } },
				(error, stdout) => (error ? reject(error) : resolve(stdout)),
			);
		}),
	);
	const sealed = await Promise.all(children);
	resetVault();
	for (const value of sealed) assert.match((await unseal(value)) ?? "", /^sk-\d+$/, "sealed with the key that stayed");
});

test("the key file is 0600, and so is the store beside it", async () => {
	// Windows NTFS does not support POSIX file mode bits (reports 0666)
	if (process.platform === "win32") return;
	await saveSettings(withProviders(provider("p1", "sk-one")));
	for (const name of ["vault.key", "credentials.json"]) {
		const mode = (await stat(join(home, name))).mode & 0o777;
		assert.equal(mode, 0o600, `${name} is ${mode.toString(8)}`);
	}
});

// ---------------------------------------------------------------------------
// What settings.json is left holding
// ---------------------------------------------------------------------------

test("saving takes the keys out of settings.json and gives them back on load", async () => {
	await saveSettings(withProviders(provider("p1", "sk-one"), provider("p2", "sk-two")));

	const onDisk = await readFile(settingsPath(), "utf8");
	assert.ok(!onDisk.includes("sk-one"), "settings.json still had a key in it");
	assert.ok(!onDisk.includes("sk-two"), "settings.json still had a key in it");

	// And the rest of the app, which reads `provider.apiKey`, sees no difference at all.
	const back = await loadSettings();
	assert.deepEqual(
		back.providers.map((p) => [p.id, p.apiKey]),
		[
			["p1", "sk-one"],
			["p2", "sk-two"],
		],
	);
});

test("settings.json stops being world-readable", async () => {
	// Windows NTFS does not support POSIX file mode bits (reports 0666)
	if (process.platform === "win32") return;
	await saveSettings(withProviders(provider("p1", "sk-one")));
	const mode = (await stat(settingsPath())).mode & 0o777;
	assert.equal(mode, 0o600, `settings.json is ${mode.toString(8)}`);
});

test("deleting a provider forgets its key rather than orphaning it", async () => {
	await saveSettings(withProviders(provider("p1", "sk-one"), provider("p2", "sk-two")));
	await saveSettings(withProviders(provider("p1", "sk-one")));

	const stored = JSON.parse(await readFile(join(home, "credentials.json"), "utf8")) as {
		secrets: Record<string, string>;
	};
	assert.deepEqual(Object.keys(stored.secrets), ["provider:p1"], "p2's key outlived p2");
});

// ---------------------------------------------------------------------------
// Plaintext keys in the file
// ---------------------------------------------------------------------------

/** A settings file with keys typed straight into it. */
async function writePlaintextSettings(keys: [string, string][]): Promise<void> {
	const settings = withProviders(...keys.map(([id, key]) => provider(id, key)));
	await writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
}

test("a key typed into settings.json is still read", async () => {
	await writePlaintextSettings([["p1", "sk-typed"]]);
	resetVault();

	const loaded = await loadSettings();
	assert.equal(loaded.providers[0].apiKey, "sk-typed");
});

test("a stale plaintext key does not overwrite a newer one in the vault", async () => {
	// The file still carries an old key and the vault has since been given a replacement.
	await saveSettings(withProviders(provider("p1", "sk-current")));

	const stale = withProviders(provider("p1", "sk-stale"));
	await writeFile(settingsPath(), JSON.stringify(stale, null, 2), "utf8");
	resetVault();

	assert.equal((await loadSettings()).providers[0].apiKey, "sk-current");
});
