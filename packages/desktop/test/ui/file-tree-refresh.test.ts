/**
 * 刷新文件树：K 个展开的目录，读完一次写进去，没变的目录保留原来那份。
 *
 * 从前每个目录各写一次、每次都是新数组，磁盘上什么都没动，整棵树也要重画 K 遍。
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { FileEntry } from "@plume/contract";
import { useFileTreeStore } from "../../src/store/fileTree.ts";

const file = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, isDirectory: false, size: 1 });
const folder = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, isDirectory: true, size: 0 });

function disk(t: TestContext) {
	const listing: Record<string, FileEntry[]> = {
		"/p": [folder("/p/a"), folder("/p/b"), folder("/p/c")],
		"/p/a": [file("/p/a/1.ts")],
		"/p/b": [file("/p/b/2.ts")],
		"/p/c": [file("/p/c/3.ts")],
	};
	const previous = Object.getOwnPropertyDescriptor(window, "plume");
	// 每次都给一份新的数组，和 IPC 送回来的一样。
	Object.defineProperty(window, "plume", { configurable: true, value: { files: { list: async (dir: string) => (listing[dir] ?? []).map((entry) => ({ ...entry })) } } });
	useFileTreeStore.setState({ children: {}, expanded: new Set() });
	t.after(() => { if (previous) Object.defineProperty(window, "plume", previous); else Reflect.deleteProperty(window, "plume"); });
	return listing;
}

async function opened() {
	const store = useFileTreeStore.getState();
	await store.load("/p");
	for (const dir of ["/p/a", "/p/b", "/p/c"]) useFileTreeStore.getState().expand(dir);
	await useFileTreeStore.getState().refresh(["/p/a", "/p/b", "/p/c"]);
}

function countWrites(t: TestContext) {
	let writes = 0;
	const stop = useFileTreeStore.subscribe(() => { writes++; });
	t.after(stop);
	return () => writes;
}

test("磁盘上没变，刷新一次不写 store", async (t) => {
	disk(t);
	await opened();
	const before = useFileTreeStore.getState().children;
	const writes = countWrites(t);
	await useFileTreeStore.getState().refreshOpen(["/p"]);
	assert.equal(writes(), 0);
	assert.equal(useFileTreeStore.getState().children, before);
});

test("只变了一个目录：写一次，其他目录还是原来那份数组", async (t) => {
	const listing = disk(t);
	await opened();
	const before = useFileTreeStore.getState().children;
	listing["/p/b"] = [file("/p/b/2.ts"), file("/p/b/new.ts")];
	const writes = countWrites(t);
	await useFileTreeStore.getState().refreshOpen(["/p"]);
	const after = useFileTreeStore.getState().children;
	assert.equal(writes(), 1);
	assert.equal(after["/p/b"].length, 2);
	for (const dir of ["/p", "/p/a", "/p/c"]) assert.equal(after[dir], before[dir], `${dir} 没变，却换了一份新数组`);
});

test("一个目录读失败，其余照样落地，错误照样抛出来", async (t) => {
	const listing = disk(t);
	await opened();
	listing["/p/a"] = [file("/p/a/1.ts"), file("/p/a/more.ts")];
	const list = window.plume.files.list;
	Object.defineProperty(window, "plume", { configurable: true, value: { files: { list: (dir: string) => (dir === "/p/c" ? Promise.reject(new Error("gone")) : list(dir)) } } });
	await assert.rejects(useFileTreeStore.getState().refreshOpen(["/p"]), /gone/);
	assert.equal(useFileTreeStore.getState().children["/p/a"].length, 2);
});
