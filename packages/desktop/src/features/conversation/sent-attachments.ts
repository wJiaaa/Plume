/**
 * 一条已发出的消息带了哪些附件：从消息里存的东西配回成一排，交给气泡外那一排和句子里的标记。
 *
 * 纯整理，不碰界面——画法和交互在 `UserMessage` 与 `SentAttachmentToken` 里。
 */

import type { UserContent, UserMessage } from "@plume/core";
import { SESSION_THUMB_EDGE } from "../../../shared/session-image.ts";
import { isAttachmentBody } from "../../lib/attachment-placeholders.ts";
import { bridge } from "../../services/index.ts";
import { displayName, sentKind, type FileKind, type StripFile } from "../composer/index.ts";
import { imageBlockSrc } from "./image-block.ts";

export type ImageBlock = Extract<UserContent, { type: "image" }>;

/** 句子里那枚标记认得的一份附件。 */
export interface SentFile {
	name: string;
	label?: string;
	kind: FileKind;
	src?: string;
	path?: string;
	/** 图片的像素、文件的正文，两样都没有：进提示词的只有名字。 */
	bodiless: boolean;
}

function imageSrc(block: ImageBlock | undefined, path: string | undefined): { src?: string; full?: string } {
	const refs = block && imageBlockSrc(block, SESSION_THUMB_EDGE);
	if (refs) return refs;
	if (path) {
		const url = bridge.files.mediaUrl(path);
		return { src: url, full: url };
	}
	return {};
}

/**
 * 带了哪几个文件，认回成一排。
 *
 * 同一批附件在消息里是分开存的：图片的像素在 `content` 的 image 块里，名字和门类在 `attachments`
 * 里，后者故意不带正文（见 `UserMessage.attachments` 的说明）。要画成一排就得先把两边配回去，
 * 按次序：第 n 个门类是图片的附件，配第 n 个图片块。
 *
 * 配不齐也不能把图弄丢。转录里躺着的老消息可能根本没有 `attachments` 这一项，那时只有图片块，
 * 于是剩下的一律补在后面——少画一个附件，比多画一个要命得多。
 */
export function attachmentsOf(
	message: UserMessage,
	images: ImageBlock[],
	label: (kind: FileKind) => string,
	regionShot: string,
): StripFile[] {
	const files: StripFile[] = [];
	let at = 0;
	/* 「图片 2」里的那个 2 数的是同门类里的第几个，和输入框那边、和提示词里是同一个数。 */
	const seen = new Map<FileKind, number>();
	for (const [index, file] of (message.attachments ?? []).entries()) {
		// 转录里躺着的是一段没人再校验过的数据，缺了一项的整条跳过，别让它把整段对话一起带走。
		if (!file || typeof file !== "object") continue;
		/*
		 * 记下来的门类要复核一遍，见 `sentKind`。一份被记成图片的文档，在下面会去配一个本不属于它的图片块，
		 * 把后面的每一张图都往后错一位。
		 */
		const kind = sentKind(file);
		const kindIndex = (seen.get(kind) ?? 0) + 1;
		seen.set(kind, kindIndex);
		const block = kind === "image" ? images[at] : undefined;
		if (block) at++;
		/*
		 * 像素只属于图片。
		 *
		 * `imageSrc` 的最后一档是「没有图片块，就按路径去磁盘上取」——那是给图片兜底的：像素万一没跟着消息
		 * 走，磁盘上那一份就是它。这一问一度对每份附件都问，于是一份带着路径的 `.md` 也拿到了一个
		 * `ly-media://` 地址：气泡外面多出一张裂开的图，alt 是它的文件名；句子里那枚标记被当成图片，点它、
		 * 点「预览」都去查看器里找一张不存在的图，什么都不发生；菜单里还多出一行「复制图片」。
		 */
		const refs: { src?: string; full?: string } = kind === "image" ? imageSrc(block, file.path) : {};
		files.push({
			key: `${index}-${file.name}`,
			name: file.name,
			kind,
			/*
			 * 正文里那枚标记写的名字：图片和没有真名的是「图片 1」，其余是真名。
			 *
			 * 存下来的优先，没存的按**和输入框同一套规则**现算（见 `Composer` 的 `relabel`）。这条规则错
			 * 开过两次，两次的表现是一样的：气泡里那些标记配不上任何一份附件，整句话的标签退化成一串方
			 * 括号。两处必须是同一条。
			 */
			label: file.label ?? displayName({ name: file.name, kind, kindLabel: label(kind), kindIndex }, regionShot),
			tip: `${file.name}\n${label(kind)}`,
			...(refs.src ? { src: refs.src } : {}),
			...(refs.full ? { full: refs.full } : {}),
			/*
			 * 发送时它在哪儿。
			 *
			 * 老消息没有这一项——那时字段还不存在——于是那些附件只剩一个名字，能做的事跟着少几件。这是
			 * 对的降级：offer nothing rather than offer something that fails。
			 */
			...(file.path ? { path: file.path } : {}),
		});
	}
	for (; at < images.length; at++) {
		const refs = imageSrc(images[at], undefined);
		files.push({
			key: `image-${at}`,
			name: "",
			kind: "image",
			...(refs.src ? { src: refs.src } : {}),
			...(refs.full ? { full: refs.full } : {}),
		});
	}
	return files;
}

/**
 * 这份附件进提示词的，是不是只有它的名字。
 *
 * 看消息里实际装了什么，不按门类猜：一份 PDF 抽得出字就整篇进了提示词，扫描件和压缩包才只剩一行
 * `[… — contents not included]`（见 `attachmentStub`）。按门类猜的那一版把每一份 PDF、每一张表格都画成
 * 「只有文件名」，而那句悬停说明对一份模型明明读完了的合同是错的。
 */
function onlyNameSent(content: UserContent[], name: string): boolean {
	return content.some(
		(block) =>
			block.type === "text" &&
			isAttachmentBody(block.text) &&
			block.text.includes(`: ${name}`) &&
			block.text.trimEnd().endsWith("contents not included]"),
	);
}

/**
 * 交给气泡的那份附件清单。
 *
 * 从前这里就地 `placeAttachments` 切好段再画。现在切段在 `BubbleText` 里——它要先知道有没有
 * 标记，才能决定这段正文走 markdown 还是走行内。这里只负责把消息里存的附件整理成它认得的
 * 形状。
 */
export function sentFiles(files: StripFile[], content: UserContent[]): SentFile[] {
	return files.map((file) => ({
		name: file.name,
		label: file.label,
		kind: file.kind,
		src: file.full ?? file.src,
		/*
		 * 它在磁盘上的位置也要带过来。
		 *
		 * 这一行漏了很久，而漏掉它的表现不是「少一行菜单」：右键点在气泡里一枚文件标记上，弹出
		 * 来的是一个**空框**——没有路径就没有「打开」「在访达中显示」「复制路径」，而文件又没有
		 * 像素可复制、已经发出去的也没有「移除」，于是一行都不剩。消息里本来就存着这个路径
		 * （`MessageAttachment.path`），只是没走到这儿。
		 */
		...(file.path ? { path: file.path } : {}),
		// 图片的像素、文件的正文，两样都没有的才是「只有名字」——正文有没有，看消息里装了什么。
		bodiless: !file.src && onlyNameSent(content, file.name),
	}));
}
