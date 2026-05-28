import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	normalizePath,
} from "obsidian";

interface FolderGraphSettings {
	backlinkProperty: string;
	indexTag: string;
	linkSubfolders: boolean;
	linkCanvases: boolean;
	autoLinkOnCreate: boolean;
}

const DEFAULT_SETTINGS: FolderGraphSettings = {
	backlinkProperty: "up",
	indexTag: "folder-index",
	linkSubfolders: true,
	linkCanvases: true,
	autoLinkOnCreate: true,
};

const COLOR_COUNT = 8;

export default class FolderGraphPlugin extends Plugin {
	settings: FolderGraphSettings;

	async onload() {
		await this.loadSettings();
		this.addRibbonIcon("git-fork", "Folder Graph Organizer", () => {
			new FolderGraphModal(this.app, this).open();
		});
		this.addCommand({ id: "create-folder-index", name: "Create index note for current folder", callback: () => this.createIndexForActiveFolder() });
		this.addCommand({ id: "scan-and-link-vault", name: "Scan vault and link all notes to folder indexes", callback: () => this.scanAndLinkVault() });
		this.addCommand({ id: "create-all-indexes", name: "Create index notes for all folders", callback: () => this.createAllFolderIndexes() });
		this.addCommand({ id: "open-dashboard", name: "Open Folder Graph dashboard", callback: () => new FolderGraphModal(this.app, this).open() });
		if (this.settings.autoLinkOnCreate) {
			this.registerEvent(this.app.vault.on("create", async (file) => {
				if (file instanceof TFile) {
					if (file.extension === "md") await this.autoLinkNewNote(file);
					else if (file.extension === "canvas" && this.settings.linkCanvases) await this.autoLinkNewCanvas(file);
				}
			}));
		}
		this.addSettingTab(new FolderGraphSettingTab(this.app, this));
	}

	async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
	async saveSettings() { await this.saveData(this.settings); }

	isIndexNote(file: TFile): boolean {
		return file.parent !== null && file.basename === file.parent.name;
	}
	getIndexNotePath(folder: TFolder): string {
		return normalizePath(`${folder.path}/${folder.name}.md`);
	}
	getFolderColorId(folderName: string): number {
		let hash = 0;
		for (let i = 0; i < folderName.length; i++) { hash = (hash << 5) - hash + folderName.charCodeAt(i); hash |= 0; }
		return Math.abs(hash) % COLOR_COUNT + 1;
	}
	async getOrCreateIndexNote(folder: TFolder): Promise<TFile> {
		const path = this.getIndexNotePath(folder);
		let file = this.app.vault.getAbstractFileByPath(path);
		if (!file) { const content = this.buildIndexNoteContent(folder); file = await this.app.vault.create(path, content); new Notice(`Created index note for: ${folder.name}`); }
		return file as TFile;
	}
	buildIndexNoteContent(folder: TFolder): string {
		const tag = this.settings.indexTag;
		const colorId = this.getFolderColorId(folder.name);
		const colorTag = `folder-color-${colorId}`;
		const parent = folder.parent;
		const upLink = parent && parent.path !== "/" ? `${this.settings.backlinkProperty}:: [[${parent.name}]]\n\n` : "";
		return `---\ntags:\n  - ${tag}\n  - ${colorTag}\ncssclass: folder-index\n---\n\n${upLink}# ${folder.name}\n\n> Index note for the **${folder.name}** folder.\n\n## Notes\n\n## Subfolders\n\n## Canvases\n\n`;
	}
	async createIndexForActiveFolder() {
		const active = this.app.workspace.getActiveFile();
		if (!active) { new Notice("No active file. Open a note first."); return; }
		const folder = active.parent;
		if (!folder) { new Notice("Could not determine folder."); return; }
		await this.getOrCreateIndexNote(folder);
		await this.linkFolderContentsToIndex(folder);
	}
	async createAllFolderIndexes() {
		const folders = this.getAllFolders(); let created = 0;
		for (const folder of folders) {
			if (folder.path === "/") continue;
			const path = this.getIndexNotePath(folder);
			if (!this.app.vault.getAbstractFileByPath(path)) { await this.getOrCreateIndexNote(folder); created++; }
		}
		new Notice(`Created ${created} index note(s).`);
	}
	async scanAndLinkVault() {
		const folders = this.getAllFolders(); let linked = 0;
		const sorted = folders.filter((f) => f.path !== "/").sort((a, b) => b.path.split("/").length - a.path.split("/").length);
		for (const folder of sorted) {
			const notes = this.getNotesInFolder(folder);
			const canvases = this.getCanvasesInFolder(folder);
			const subfolders = this.getSubfolders(folder);
			if (notes.length === 0 && canvases.length === 0 && subfolders.length === 0) continue;
			await this.getOrCreateIndexNote(folder);
			const count = await this.linkFolderContentsToIndex(folder);
			linked += count;
		}
		new Notice(`Done! Linked ${linked} item(s) to their folder indexes.`);
	}
	async linkFolderContentsToIndex(folder: TFolder): Promise<number> {
		const indexPath = this.getIndexNotePath(folder);
		const indexFile = this.app.vault.getAbstractFileByPath(indexPath);
		if (!indexFile) return 0;
		let count = 0;
		const notes = this.getNotesInFolder(folder).filter((f) => f.path !== indexPath);
		for (const note of notes) {
			if (await this.addBacklinkToNote(note, folder)) count++;
			await this.addItemToIndex(indexFile as TFile, note.basename, "Notes");
		}
		if (this.settings.linkCanvases) {
			for (const canvas of this.getCanvasesInFolder(folder)) { await this.addCanvasLinkToIndex(indexFile as TFile, canvas); count++; }
		}
		if (this.settings.linkSubfolders) {
			for (const sub of this.getSubfolders(folder)) {
				const subIndexPath = this.getIndexNotePath(sub);
				let subIndex = this.app.vault.getAbstractFileByPath(subIndexPath);
				if (!subIndex) subIndex = await this.getOrCreateIndexNote(sub);
				await this.addBacklinkToNote(subIndex as TFile, folder);
				await this.addItemToIndex(indexFile as TFile, (subIndex as TFile).basename, "Subfolders");
				count++;
			}
		}
		return count;
	}
	async addBacklinkToNote(file: TFile, folder: TFolder): Promise<boolean> {
		const linkTarget = folder.name;
		const prop = this.settings.backlinkProperty;
		const linkText = `[[${linkTarget}]]`;
		const content = await this.app.vault.read(file);
		if (content.includes(linkText)) return false;
		let newContent: string;
		if (content.startsWith("---")) {
			const end = content.indexOf("---", 3);
			if (end !== -1) {
				const frontmatter = content.slice(0, end);
				const rest = content.slice(end);
				if (!frontmatter.includes(`${prop}:`)) { newContent = `${frontmatter}${prop}:: ${linkText}\n${rest}`; } else { return false; }
			} else { newContent = `${prop}:: ${linkText}\n\n${content}`; }
		} else { newContent = `${prop}:: ${linkText}\n\n${content}`; }
		await this.app.vault.modify(file, newContent);
		return true;
	}
	async addCanvasLinkToIndex(indexFile: TFile, canvas: TFile) {
		const content = await this.app.vault.read(indexFile);
		const link = `[[${canvas.basename}]]`;
		if (content.includes(link)) return;
		if (content.includes("## Canvases")) {
			await this.app.vault.modify(indexFile, content.replace("## Canvases", `## Canvases\n- ${link}`));
		} else { await this.app.vault.modify(indexFile, content + `\n- ${link}\n`); }
	}
	async addItemToIndex(indexFile: TFile, basename: string, section: string) {
		const content = await this.app.vault.read(indexFile);
		const link = `[[${basename}]]`;
		if (content.includes(link)) return;
		const header = `## ${section}`;
		if (content.includes(header)) {
			await this.app.vault.modify(indexFile, content.replace(header, `${header}\n- ${link}`));
		} else { await this.app.vault.modify(indexFile, content + `\n- ${link}\n`); }
	}
	async autoLinkNewNote(file: TFile) {
		if (this.isIndexNote(file)) return;
		const folder = file.parent;
		if (!folder || folder.path === "/") return;
		setTimeout(async () => {
			const indexPath = this.getIndexNotePath(folder);
			const indexFile = this.app.vault.getAbstractFileByPath(indexPath);
			if (indexFile instanceof TFile) { await this.addBacklinkToNote(file, folder); await this.addItemToIndex(indexFile, file.basename, "Notes"); }
		}, 500);
	}
	async autoLinkNewCanvas(file: TFile) {
		const folder = file.parent;
		if (!folder || folder.path === "/") return;
		setTimeout(async () => {
			const indexPath = this.getIndexNotePath(folder);
			const indexFile = this.app.vault.getAbstractFileByPath(indexPath);
			if (indexFile instanceof TFile) await this.addCanvasLinkToIndex(indexFile, file);
		}, 500);
	}
	getAllFolders(): TFolder[] {
		const folders: TFolder[] = [];
		const recurse = (folder: TFolder) => { folders.push(folder); folder.children.forEach((child) => { if (child instanceof TFolder) recurse(child); }); };
		recurse(this.app.vault.getRoot());
		return folders;
	}
	getNotesInFolder(folder: TFolder): TFile[] { return folder.children.filter((f) => f instanceof TFile && (f as TFile).extension === "md") as TFile[]; }
	getCanvasesInFolder(folder: TFolder): TFile[] { return folder.children.filter((f) => f instanceof TFile && (f as TFile).extension === "canvas") as TFile[]; }
	getSubfolders(folder: TFolder): TFolder[] { return folder.children.filter((f) => f instanceof TFolder) as TFolder[]; }
	getFolderStats() {
		return this.getAllFolders().filter((f) => f.path !== "/").map((folder) => {
			const indexPath = this.getIndexNotePath(folder);
			const hasIndex = !!this.app.vault.getAbstractFileByPath(indexPath);
			const colorId = this.getFolderColorId(folder.name);
			return { folder: folder.name, path: folder.path, noteCount: this.getNotesInFolder(folder).length, canvasCount: this.getCanvasesInFolder(folder).length, subfolderCount: this.getSubfolders(folder).length, hasIndex, depth: folder.path.split("/").length, colorId };
		});
	}
}

class FolderGraphModal extends Modal {
	plugin: FolderGraphPlugin;
	constructor(app: App, plugin: FolderGraphPlugin) { super(app); this.plugin = plugin; }
	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("folder-graph-modal");
		const header = contentEl.createDiv("fgm-header");
		header.createEl("h2", { text: "Folder Graph Organizer" });
		header.createEl("p", { text: "Organize your vault so each folder becomes a cluster in graph view.", cls: "fgm-subtitle" });
		const stats = this.plugin.getFolderStats();
		const statsGrid = contentEl.createDiv("fgm-stats-grid");
		this.statCard(statsGrid, String(stats.length), "Total Folders");
		this.statCard(statsGrid, String(stats.filter((s) => s.hasIndex).length), "Have Index Notes");
		this.statCard(statsGrid, String(stats.reduce((sum, s) => sum + s.noteCount, 0)), "Notes");
		this.statCard(statsGrid, String(stats.reduce((sum, s) => sum + s.canvasCount, 0)), "Canvases");
		const actions = contentEl.createDiv("fgm-actions");
		actions.createEl("h3", { text: "Actions" });
		const btnRow = actions.createDiv("fgm-btn-row");
		const btnAll = btnRow.createEl("button", { text: "Create All Index Notes", cls: "fgm-btn fgm-btn-primary" });
		btnAll.onclick = async () => { await this.plugin.createAllFolderIndexes(); this.onOpen(); };
		const btnScan = btnRow.createEl("button", { text: "Scan & Link Everything", cls: "fgm-btn fgm-btn-secondary" });
		btnScan.onclick = async () => { await this.plugin.scanAndLinkVault(); this.onOpen(); };
		const btnCurrent = btnRow.createEl("button", { text: "Index Current Folder", cls: "fgm-btn fgm-btn-ghost" });
		btnCurrent.onclick = async () => { await this.plugin.createIndexForActiveFolder(); this.onOpen(); };
		if (stats.length > 0) {
			const listSection = contentEl.createDiv("fgm-folder-list");
			listSection.createEl("h3", { text: "Folder Status" });
			const table = listSection.createEl("table", { cls: "fgm-table" });
			const thead = table.createEl("thead").createEl("tr");
			["", "Folder", "Notes", "Canvas", "Sub", "Index", ""].forEach((h) => thead.createEl("th", { text: h }));
			const tbody = table.createEl("tbody");
			stats.forEach((stat) => {
				const row = tbody.createEl("tr");
				const indent = "\xA0\xA0".repeat(Math.max(0, stat.depth - 1));
				row.createEl("td").createEl("span", { cls: `fgm-color-swatch fgm-color-${stat.colorId}` });
				row.createEl("td", { text: indent + stat.path, cls: "fgm-path" });
				row.createEl("td", { text: String(stat.noteCount), cls: "fgm-center" });
				row.createEl("td", { text: String(stat.canvasCount), cls: "fgm-center" });
				row.createEl("td", { text: String(stat.subfolderCount), cls: "fgm-center" });
				row.createEl("td", { cls: "fgm-center" }).createEl("span", { text: stat.hasIndex ? "✓" : "✗", cls: stat.hasIndex ? "fgm-ok" : "fgm-missing" });
				const actionCell = row.createEl("td");
				if (!stat.hasIndex) {
					const btn = actionCell.createEl("button", { text: "Create", cls: "fgm-btn fgm-btn-xs" });
					btn.onclick = async () => {
						const folder = this.app.vault.getAbstractFileByPath(stat.path);
						if (folder instanceof TFolder) { await this.plugin.getOrCreateIndexNote(folder); await this.plugin.linkFolderContentsToIndex(folder); this.onOpen(); }
					};
				}
			});
		}
		const tip = contentEl.createDiv("fgm-callout");
		tip.createEl("strong", { text: "Graph View tip: " });
		tip.createSpan({ text: `In Graph View → Groups, add groups for tag:${this.plugin.settings.indexTag} to highlight all hubs, or add groups for tag:folder-color-1 through tag:folder-color-8 to give each folder cluster its own distinct color.` });
	}
	statCard(container: HTMLElement, value: string, label: string) {
		const card = container.createDiv("fgm-stat-card");
		card.createEl("div", { text: value, cls: "fgm-stat-value" });
		card.createEl("div", { text: label, cls: "fgm-stat-label" });
	}
	onClose() { this.contentEl.empty(); }
}

class FolderGraphSettingTab extends PluginSettingTab {
	plugin: FolderGraphPlugin;
	constructor(app: App, plugin: FolderGraphPlugin) { super(app, plugin); this.plugin = plugin; }
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Folder Graph Organizer" });
		new Setting(containerEl).setName("Backlink property name").setDesc("The inline property used to link notes back to their folder index").addText((text) => text.setPlaceholder("up").setValue(this.plugin.settings.backlinkProperty).onChange(async (value) => { this.plugin.settings.backlinkProperty = value || "up"; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("Index note tag").setDesc("Tag applied to all index notes (use in Graph View group filters)").addText((text) => text.setPlaceholder("folder-index").setValue(this.plugin.settings.indexTag).onChange(async (value) => { this.plugin.settings.indexTag = value || "folder-index"; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("Link subfolders to parent").setDesc("Each subfolder's index note gets an up:: link to its parent folder's index, connecting the clusters in graph view").addToggle((toggle) => toggle.setValue(this.plugin.settings.linkSubfolders).onChange(async (value) => { this.plugin.settings.linkSubfolders = value; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("Link canvas files").setDesc("Canvas files in a folder get listed in that folder's index note").addToggle((toggle) => toggle.setValue(this.plugin.settings.linkCanvases).onChange(async (value) => { this.plugin.settings.linkCanvases = value; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("Auto-link new files").setDesc("Automatically link newly created notes and canvases to their folder index").addToggle((toggle) => toggle.setValue(this.plugin.settings.autoLinkOnCreate).onChange(async (value) => { this.plugin.settings.autoLinkOnCreate = value; await this.plugin.saveSettings(); }));
		containerEl.createEl("h3", { text: "Graph View Color Groups" });
		const info = containerEl.createDiv("fgm-settings-info");
		info.createEl("p", { text: "Each folder index is tagged with folder-color-1 through folder-color-8 (assigned by folder name). To color them in Graph View:" });
		const ol = info.createEl("ol");
		ol.createEl("li", { text: 'Open Graph View → click the sliders icon → "Groups"' });
		ol.createEl("li", { text: "Add a group, set query to: tag:folder-color-1" });
		ol.createEl("li", { text: "Pick a color, repeat for folder-color-2 through folder-color-8" });
	}
}
