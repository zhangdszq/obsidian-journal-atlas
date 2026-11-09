"use strict";

const {
  ItemView, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, moment, normalizePath, setIcon
} = require("obsidian");

const VIEW_TYPE = "journal-atlas-view";
const DAY = 86400000;
const WEEK_FORMAT = "GGGG-[W]WW";
const KINDS = { daily: "日记", weekly: "周记" };
const DEFAULT_SECTIONS = "待办 | 今日待办 | 未完成待办\n学习\n思考\n日记 | 工作日记";
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function dateAt(year, month = 0, day = 1) {
  return new Date(Date.UTC(year, month, day));
}

function today() {
  const local = new Date();
  return dateAt(local.getFullYear(), local.getMonth(), local.getDate());
}

function addDays(date, count) {
  return new Date(date.getTime() + count * DAY);
}

function weekStart(date) {
  return addDays(date, -((date.getUTCDay() + 6) % 7));
}

function weekYear(date) {
  return addDays(weekStart(date), 3).getUTCFullYear();
}

function firstWeek(year) {
  return weekStart(dateAt(year, 0, 4));
}

function weekNumber(date) {
  return 1 + Math.round((weekStart(date) - firstWeek(weekYear(date))) / (7 * DAY));
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function weekKey(date) {
  return `${weekYear(date)}-W${String(weekNumber(date)).padStart(2, "0")}`;
}

function periodKey(kind, date) {
  return kind === "daily" ? dayKey(date) : weekKey(date);
}

function headingKey(title) {
  return title.normalize("NFKC").trim()
    .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, "")
    .replace(/^(?:\d+(?:\.\d+)*[.、)]|\(\d+\))\s*/, "")
    .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, "")
    .replace(/[*_`]/g, "").replace(/[:：]\s*$/, "").trim().toLowerCase();
}

function parseSections(text) {
  const labels = new Set();
  const sections = [];
  for (const line of text.split(/\r?\n/)) {
    const names = line.split("|").map(name => name.trim()).filter(name => headingKey(name));
    if (!names.length || labels.has(headingKey(names[0]))) continue;
    labels.add(headingKey(names[0]));
    sections.push({ label: names[0], aliases: [...new Set(names.map(headingKey))] });
  }
  return sections;
}

function visibleText(line, comment) {
  let text = "";
  while (line.length) {
    if (comment.end) {
      const end = line.indexOf(comment.end);
      if (end < 0) break;
      line = line.slice(end + comment.end.length);
      comment.end = "";
    } else {
      const start = /<!--|%%/.exec(line);
      if (!start) return text + line;
      text += line.slice(0, start.index);
      comment.end = start[0] === "%%" ? "%%" : "-->";
      line = line.slice(start.index + start[0].length);
    }
  }
  return text;
}

function hasBody(line) {
  const text = line.trim().replace(/^(?:>\s*)+/, "")
    .replace(/^(?:[-+*]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX-]\](?:\s+|$)/, "").trim();
  return Boolean(text) && !/^(?:[-+*]|\d+[.)]|\[![\w-]+\][+-]?|<br\s*\/?\s*>)$/i.test(text)
    && !/^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|#+)$/.test(text);
}

function analyzeMarkdown(markdown) {
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (/^---\s*$/.test(lines[0])) {
    const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
    if (end !== -1) lines.splice(0, end + 1);
  }

  const present = new Set();
  const filled = new Set();
  const stack = [];
  const comment = { end: "" };
  let any = false;
  let fence = null;

  function recordBody() {
    any = true;
    for (const heading of stack) filled.add(heading.key);
  }

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(raw);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = null;
      else if (raw.trim()) recordBody();
      continue;
    }

    if (!comment.end) {
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
      if (opening) {
        fence = opening[1];
        continue;
      }
    }
    const line = visibleText(raw, comment);
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
    const paragraph = !/^(?: {4}|\t| {0,3}(?:>|(?:[-+*]|\d+[.)])(?:\s|$)))/.test(line);
    const setext = !atx && paragraph && hasBody(line) && /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[index + 1] || "");
    if (atx || setext) {
      const depth = atx ? atx[1].length : setext[1][0] === "=" ? 1 : 2;
      const title = atx ? atx[2].replace(/\s+#+\s*$/, "") : line;
      if (setext) index++;
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      const key = headingKey(title);
      if (key) {
        present.add(key);
        stack.push({ key, depth });
      }
    } else if (hasBody(line)) {
      recordBody();
    }
  }
  return { any, present, filled };
}

function cleanPath(path) {
  const trimmed = path.trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? normalizePath(trimmed) : "";
}

function normalizeFormat(kind, format) {
  if (kind === "weekly" && !format.includes("GGGG") && /WW|\bW\b/.test(format)) {
    return format.replace("YYYY", "GGGG");
  }
  return format;
}

function matchPeriod(path, kind, config) {
  if (!/\.md$/i.test(path) || (config.folder && !path.startsWith(config.folder + "/"))) return null;
  const relative = path.slice(config.folder ? config.folder.length + 1 : 0, -3);
  const format = config.format;
  const partCount = format.split("/").length;
  const name = relative.split("/").slice(-partCount).join("/");
  const parsed = moment.utc(name, format, true);
  if (!parsed.isValid() || parsed.format(format) !== name) return null;
  return periodKey(kind, parsed.toDate());
}

function summarize(notes, sections) {
  const statuses = sections.map(section => {
    const written = notes.some(note => section.aliases.some(alias => note.filled.has(alias)));
    if (written) return "written";
    const present = notes.some(note => section.aliases.some(alias => note.present.has(alias)));
    return present ? "blank" : "absent";
  });
  return {
    notes, statuses,
    any: notes.some(note => note.any),
    count: statuses.filter(status => status === "written").length
  };
}

function colorLevel(summary, filter) {
  if (filter >= 0) return summary.statuses[filter] === "written" ? 3 : 0;
  return summary.any ? Math.min(4, Math.max(1, summary.count)) : 0;
}

function makeGroups(records) {
  const groups = { daily: new Map(), weekly: new Map() };
  for (const record of records.values()) {
    for (const kind of Object.keys(KINDS)) {
      const key = record[kind];
      if (!key) continue;
      const group = groups[kind].get(key) || [];
      group.push(record);
      groups[kind].set(key, group);
    }
  }
  for (const map of Object.values(groups)) {
    for (const group of map.values()) {
      group.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
    }
  }
  return groups;
}

class JournalAtlasPlugin extends Plugin {
  async onload() {
    this.records = new Map();
    this.groups = makeGroups(this.records);
    this.pending = new Set();
    this.readFailures = new Set();
    this.ready = false;
    this.saveQueue = Promise.resolve();
    const [saved, core, calendar, periodic] = await Promise.all([
      this.loadData(),
      this.readConfig("daily-notes.json"),
      this.readConfig("plugins/calendar/data.json"),
      this.readConfig("plugins/periodic-notes/data.json")
    ]);
    const daily = periodic.daily?.enabled ? periodic.daily : core;
    const weekly = periodic.weekly?.enabled ? periodic.weekly : {
      folder: calendar.weeklyNoteFolder,
      format: calendar.weeklyNoteFormat,
      template: calendar.weeklyNoteTemplate
    };
    this.config = {
      daily: { folder: daily.folder || "", format: daily.format || "YYYY-MM-DD", template: daily.template || "" },
      weekly: { folder: weekly.folder || daily.folder || "", format: weekly.format || WEEK_FORMAT, template: weekly.template || "" },
      sections: typeof saved?.sections === "string" ? saved.sections : DEFAULT_SECTIONS
    };
    for (const kind of Object.keys(KINDS)) {
      for (const field of ["folder", "format", "template"]) {
        if (typeof saved?.[kind]?.[field] === "string") this.config[kind][field] = saved[kind][field];
      }
      this.config[kind].folder = cleanPath(this.config[kind].folder);
      this.config[kind].format = normalizeFormat(kind, this.config[kind].format);
      if (!this.config[kind].format) this.config[kind].format = kind === "daily" ? "YYYY-MM-DD" : WEEK_FORMAT;
    }

    this.registerView(VIEW_TYPE, leaf => new JournalAtlasView(leaf, this));
    this.addRibbonIcon("calendar-range", "Open Journal Atlas", () => this.openAtlas());
    this.addCommand({ id: "open", name: "Open Journal Atlas", callback: () => this.openAtlas() });
    this.addCommand({ id: "refresh", name: "Refresh journal index", callback: () => this.queueFull() });
    this.addSettingTab(new JournalAtlasSettings(this.app, this));

    const vault = this.app.vault;
    for (const event of ["create", "modify", "delete"]) {
      this.registerEvent(vault.on(event, file => {
        if (file instanceof TFile) this.queuePath(file.path);
        else if (event === "delete") this.queueFull();
      }));
    }
    this.registerEvent(vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) {
        this.queuePath(oldPath);
        this.queuePath(file.path);
      } else {
        this.queueFull();
      }
    }));
    this.app.workspace.onLayoutReady(() => this.queueFull());
  }

  onunload() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  async readConfig(file) {
    try {
      const value = JSON.parse(await this.app.vault.adapter.read(`${this.app.vault.configDir}/${file}`));
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  async openAtlas() {
    const workspace = this.app.workspace;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  updateSetting(kind, field, value) {
    if (kind) {
      this.config[kind][field] = value;
      this.queueFull();
    } else {
      this.config.sections = value;
      this.renderViews();
    }
    const snapshot = JSON.parse(JSON.stringify(this.config));
    this.saveQueue = this.saveQueue.then(() => this.saveData(snapshot)).catch(error => {
      console.error("Journal Atlas settings:", error);
      new Notice("Journal Atlas 设置保存失败");
    });
  }

  queueFull() {
    this.full = true;
    this.schedule();
  }

  queuePath(path) {
    if (!/\.md$/i.test(path)) return;
    if (!this.records.has(path) && !Object.keys(KINDS).some(kind => matchPeriod(path, kind, this.config[kind]))) return;
    this.pending.add(path);
    this.schedule();
  }

  schedule() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.indexNotes(), 160);
  }

  async indexNotes() {
    if (this.indexing || this.stopped) return;
    this.indexing = true;
    try {
      while (!this.stopped && (this.full || this.pending.size)) {
        const rebuild = this.full;
        const records = rebuild ? new Map() : new Map(this.records);
        const failures = rebuild ? new Set() : new Set(this.readFailures);
        const paths = rebuild ? this.app.vault.getMarkdownFiles().map(file => file.path) : [...this.pending];
        const { daily, weekly } = JSON.parse(JSON.stringify(this.config));
        this.full = false;
        this.pending.clear();
        for (let index = 0; index < paths.length && !this.stopped && !this.full; index += 24) {
          await Promise.all(paths.slice(index, index + 24).map(async path => {
            records.delete(path);
            failures.delete(path);
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return;
            const day = matchPeriod(path, "daily", daily);
            const week = matchPeriod(path, "weekly", weekly);
            if (!day && !week) return;
            try {
              const analysis = analyzeMarkdown(await this.app.vault.cachedRead(file));
              records.set(path, { path, daily: day, weekly: week, ...analysis });
            } catch {
              failures.add(path);
            }
          }));
        }
        if (!this.stopped && !this.full) {
          this.records = records;
          this.readFailures = failures;
          this.groups = makeGroups(records);
          this.ready = true;
          this.renderViews();
        }
      }
    } catch (error) {
      console.error("Journal Atlas index:", error);
      new Notice("Journal Atlas 统计失败，可从命令面板重新统计");
    } finally {
      this.indexing = false;
    }
  }

  renderViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.render();
  }

  async openNote(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.queuePath(path);
      new Notice("这篇笔记已移动或删除");
      return;
    }
    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType("markdown").find(leaf => leaf.view.file?.path === path);
    if (existing) await workspace.revealLeaf(existing);
    else await workspace.getLeaf("tab").openFile(file);
  }

  async createNote(kind, date) {
    const { folder, format, template } = this.config[kind];
    const noteDate = kind === "weekly" ? weekStart(date) : date;
    const formatted = moment.utc(noteDate).format(format);
    const title = formatted.split("/").pop();
    const path = cleanPath(`${folder ? folder + "/" : ""}${formatted}.md`);
    try {
      if (matchPeriod(path, kind, this.config[kind]) !== periodKey(kind, date)) {
        throw new Error("笔记格式无法对应所选日期，请检查 Journal Atlas 设置");
      }
      const vault = this.app.vault;
      const existing = this.groups[kind].get(periodKey(kind, date))?.find(note => vault.getAbstractFileByPath(note.path) instanceof TFile);
      if (existing) return this.openNote(existing.path);
      if (vault.getAbstractFileByPath(path) instanceof TFile) return this.openNote(path);

      let content = "";
      if (template) {
        const templatePath = cleanPath(/\.md$/i.test(template) ? template : template + ".md");
        const file = vault.getAbstractFileByPath(templatePath);
        if (!(file instanceof TFile)) throw new Error("找不到所配置的笔记模板");
        content = (await vault.cachedRead(file)).replace(/\{\{\s*(date|time|title)(?::([^}]+))?\s*\}\}/gi,
          (original, type, pattern) => {
            const key = type.toLowerCase();
            if (key === "title") return title;
            if (key === "time") return moment().format(pattern?.trim() || "HH:mm");
            return moment.utc(noteDate).format(pattern?.trim() || "YYYY-MM-DD");
          });
      }
      const parts = path.split("/");
      parts.pop();
      let parent = "";
      for (const part of parts) {
        parent = parent ? `${parent}/${part}` : part;
        if (vault.getAbstractFileByPath(parent) instanceof TFolder) continue;
        try {
          await vault.createFolder(parent);
        } catch (error) {
          if (!(vault.getAbstractFileByPath(parent) instanceof TFolder)) throw error;
        }
      }
      try {
        await vault.create(path, content);
      } catch (error) {
        if (!(vault.getAbstractFileByPath(path) instanceof TFile)) throw error;
      }
      this.queuePath(path);
      await this.openNote(path);
    } catch (error) {
      new Notice(`无法新建${KINDS[kind]}：${error.message}`);
    }
  }
}

class JournalAtlasSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const root = this.containerEl;
    root.replaceChildren();
    root.createEl("h2", { text: "Journal Atlas" });
    for (const [kind, name] of Object.entries(KINDS)) {
      new Setting(root).setName(name).setHeading();
      const sample = kind === "daily" ? "YYYY-MM-DD" : WEEK_FORMAT;
      const fields = [
        ["folder", "笔记文件夹", "相对于仓库根目录。留空搜索整个仓库，子文件夹会一起统计。", "日记"],
        ["format", "文件名格式", `使用 Moment 格式，例如 ${sample}。请包含完整的年和日或周。`, sample],
        ["template", "新建时使用的模板", "填写仓库内模板路径，可省略 .md。留空会创建空白笔记。", "日记/模板"]
      ];
      for (const [field, label, help, placeholder] of fields) {
        new Setting(root).setName(label).setDesc(help).addText(component => {
          const input = component.setValue(this.plugin.config[kind][field]).setPlaceholder(placeholder).inputEl;
          input.addEventListener("change", () => {
            const value = field === "format" ? normalizeFormat(kind, input.value.trim() || sample) : cleanPath(input.value);
            input.value = value;
            this.plugin.updateSetting(kind, field, value);
          });
        });
      }
    }
    new Setting(root).setName("统计板块").setHeading();
    new Setting(root).setName("标题与别名")
      .setDesc("日记和周记共用这份清单。每行一个板块，用 | 分隔标题和别名。比如「待办 | 今日待办」。标题层级和开头编号会自动识别。")
      .addTextArea(component => {
        const input = component.setValue(this.plugin.config.sections).inputEl;
        input.rows = 6;
        input.cols = 32;
        input.addEventListener("change", () => this.plugin.updateSetting(null, null, input.value));
      });
  }
}

class JournalAtlasView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.kind = "daily";
    this.date = today();
    this.filterLabel = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Journal Atlas"; }
  getIcon() { return "calendar-range"; }

  async onOpen() {
    this.render();
  }

  select(kind, date, focus) {
    this.kind = kind;
    this.date = date;
    this.render(focus);
  }

  get year() {
    return this.kind === "daily" ? this.date.getUTCFullYear() : weekYear(this.date);
  }

  changeYear(amount) {
    const year = this.year + amount;
    if (year < 1900 || year > 9998) return;
    if (this.kind === "weekly") {
      const first = firstWeek(year);
      const last = firstWeek(year + 1);
      const date = addDays(first, Math.min(weekNumber(this.date) - 1, (last - first) / (7 * DAY) - 1) * 7 + 3);
      this.select(this.kind, date);
    } else {
      const month = this.date.getUTCMonth();
      const day = Math.min(this.date.getUTCDate(), dateAt(year, month + 1, 0).getUTCDate());
      this.select(this.kind, dateAt(year, month, day));
    }
  }

  changeMonth(amount) {
    const month = dateAt(this.date.getUTCFullYear(), this.date.getUTCMonth() + amount, 1);
    if (month.getUTCFullYear() < 1900 || month.getUTCFullYear() > 9998) return;
    this.select(this.kind, this.kind === "weekly" ? addDays(weekStart(addDays(month, 3)), 3) : month);
  }

  button(parent, { text, icon, label = text, cls, id, action }) {
    const button = parent.createEl("button", { cls, text, attr: { type: "button", title: label, "aria-label": label } });
    if (id) button.dataset.journalFocus = id;
    if (icon) setIcon(button, icon);
    button.addEventListener("click", action);
    return button;
  }

  setFilter(label) {
    this.filterLabel = label;
    this.render();
  }

  getSummary(kind, date) {
    const key = periodKey(kind, date);
    if (!this.summaries[kind].has(key)) {
      const notes = this.plugin.groups[kind].get(key) || [];
      this.summaries[kind].set(key, summarize(notes, this.sections));
    }
    return this.summaries[kind].get(key);
  }

  describe(summary, filter = this.filter) {
    if (!summary.notes.length) return "无笔记";
    if (filter >= 0) {
      const state = { written: "已记录", blank: "板块空白", absent: "无此板块" };
      return `${this.sections[filter].label} · ${state[summary.statuses[filter]]}`;
    }
    if (!summary.any) return "笔记空白";
    return summary.count ? `${summary.count} 个板块有记录` : "有正文";
  }

  render(restoreFocus) {
    const content = this.contentEl;
    const doc = content.ownerDocument;
    const focusId = restoreFocus || (content.contains(doc.activeElement) && doc.activeElement.dataset?.journalFocus);
    const oldHeat = content.querySelector(".ja-scroll");
    const scrollLeft = oldHeat?.scrollLeft || 0;
    content.replaceChildren();
    content.addClass("ja-view");
    this.sections = parseSections(this.plugin.config.sections);
    this.filter = this.sections.findIndex(section => section.label === this.filterLabel);
    if (this.filter < 0) this.filterLabel = null;
    this.summaries = { daily: new Map(), weekly: new Map() };

    const root = content.createDiv("ja-root");
    const header = root.createDiv("ja-header");
    const titles = header.createDiv();
    titles.createDiv({ cls: "ja-kicker", text: "WRITING ACTIVITY" });
    titles.createEl("h1", { text: "Journal Atlas" });
    const modes = header.createDiv({ cls: "ja-modes", attr: { role: "group", "aria-label": "笔记类型" } });
    for (const [kind, name] of Object.entries(KINDS)) {
      const button = this.button(modes, { text: name, id: kind, action: () => {
        if (this.kind !== kind) this.select(kind, this.date);
      } });
      button.setAttribute("aria-pressed", String(this.kind === kind));
    }

    if (!this.plugin.ready) {
      root.createEl("p", { cls: "ja-empty", text: "正在读取日记和周记…", attr: { role: "status" } });
      return;
    }

    const heat = this.renderHeatmap(root);
    const lower = root.createDiv("ja-lower");
    this.renderCalendar(lower);
    this.renderDetails(lower);

    if (this.plugin.readFailures.size) {
      root.createEl("p", { cls: "ja-empty", text: `${this.plugin.readFailures.size} 篇笔记暂时无法读取，可从命令面板重新统计。` });
    }

    heat.scrollLeft = scrollLeft;
    if (focusId) {
      const next = [...content.querySelectorAll("[data-journal-focus]")].find(button => button.dataset.journalFocus === focusId);
      if (next) {
        next.focus({ preventScroll: true });
        if (heat.contains(next)) {
          const cell = next.getBoundingClientRect();
          const area = heat.getBoundingClientRect();
          if (cell.left < area.left) heat.scrollLeft += cell.left - area.left - 4;
          if (cell.right > area.right) heat.scrollLeft += cell.right - area.right + 4;
        }
      }
    } else if (!oldHeat) {
      const selected = heat.querySelector('[aria-pressed="true"]');
      if (selected) heat.scrollLeft = Math.max(0, selected.offsetLeft - heat.clientWidth + 36);
    }
  }

  renderHeatmap(root) {
    const panel = root.createEl("section", { cls: "ja-heat", attr: { "aria-label": "年度热力图" } });
    const header = panel.createDiv("ja-panel-header");
    const headline = header.createDiv();
    headline.createEl("h2", { text: "年度热力图" });
    const entries = [...this.plugin.groups[this.kind].entries()].filter(([key]) => key.startsWith(`${this.year}-`));
    const yearSummaries = entries.map(([, notes]) => summarize(notes, this.sections));
    const written = yearSummaries.filter(summary => summary.any).length;
    const unit = this.kind === "daily" ? "天" : "周";
    headline.createDiv({ cls: "ja-muted", text: `${written} ${unit}有内容 · ${entries.length} ${unit}有笔记` });

    const nav = header.createDiv("ja-nav");
    this.button(nav, { icon: "chevron-left", label: "上一年", id: "previous-year", action: () => this.changeYear(-1) });
    nav.createSpan({ cls: "ja-year", text: String(this.year) });
    this.button(nav, { icon: "chevron-right", label: "下一年", id: "next-year", action: () => this.changeYear(1) });

    const filters = panel.createDiv({ cls: "ja-filters", attr: { role: "group", "aria-label": "按板块查看" } });
    const filterItems = [{ label: "整篇", count: written, value: null }];
    this.sections.forEach((section, index) => {
      const count = yearSummaries.filter(summary => summary.statuses[index] === "written").length;
      filterItems.push({ label: section.label, count, value: section.label });
    });
    filterItems.forEach(({ label, count, value }, index) => {
      const button = this.button(filters, {
        text: label, label: `${label}，${count} ${unit}有记录`,
        id: `filter-${index}`, action: () => this.setFilter(value)
      });
      button.createSpan({ text: String(count), cls: "ja-filter-count" });
      button.setAttribute("aria-pressed", String(this.filterLabel === value));
    });

    const scroll = panel.createDiv("ja-scroll");
    if (this.kind === "daily") this.renderDailyHeat(scroll);
    else this.renderWeeklyHeat(scroll);

    const legend = panel.createDiv("ja-legend");
    const swatch = (name, cls) => {
      legend.createSpan({ cls: `ja-swatch ${cls}`, attr: { "aria-hidden": "true" } });
      legend.createSpan({ text: name });
    };
    swatch("无笔记", "");
    swatch(this.filter < 0 ? "笔记空白" : "板块未记录", "ja-note");
    if (this.filter < 0) {
      swatch("有内容", "ja-level-1");
      swatch("多个板块", "ja-level-4");
    } else {
      swatch("板块已记录", "ja-level-3");
    }
    return scroll;
  }

  mark(element, summary) {
    element.classList.add(`ja-level-${colorLevel(summary, this.filter)}`);
    element.classList.toggle("ja-note", summary.notes.length > 0);
  }

  heatCell(grid, date, weekly) {
    const key = periodKey(this.kind, date);
    const summary = this.getSummary(this.kind, date);
    const id = `heat-${key}`;
    const chosen = key === periodKey(this.kind, this.date);
    const button = this.button(grid, {
      cls: "ja-heat-cell", text: weekly ? key.slice(5) : undefined, id,
      label: `${key} · ${this.describe(summary)}`,
      action: () => this.select(this.kind, weekly ? addDays(date, 3) : date, id)
    });
    this.mark(button, summary);
    button.tabIndex = chosen ? 0 : -1;
    button.setAttribute("aria-pressed", String(chosen));
    button.classList.toggle("ja-current", key === periodKey(this.kind, today()));
    button.addEventListener("keydown", event => {
      const arrows = weekly ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -13, ArrowDown: 13 }
        : { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
      if (!(event.key in arrows)) return;
      event.preventDefault();
      const next = addDays(date, weekly ? arrows[event.key] * 7 + 3 : arrows[event.key]);
      this.select(this.kind, next, `heat-${periodKey(this.kind, next)}`);
    });
  }

  renderDailyHeat(scroll) {
    const calendar = scroll.createDiv("ja-github");
    const labels = calendar.createDiv("ja-day-labels");
    WEEKDAYS.forEach((day, index) => labels.createSpan({ text: index % 2 === 0 ? day : "" }));
    const chart = calendar.createDiv();
    const start = dateAt(this.year);
    const end = dateAt(this.year + 1);
    const startGrid = weekStart(start);
    const columns = Math.ceil((end - startGrid) / (7 * DAY));
    const months = chart.createDiv("ja-month-labels");
    const grid = chart.createDiv("ja-days");
    months.style.setProperty("--ja-weeks", String(columns));
    grid.style.setProperty("--ja-weeks", String(columns));
    for (let month = 0; month < 12; month++) {
      const col = Math.floor((dateAt(this.year, month) - startGrid) / (7 * DAY)) + 1;
      months.createSpan({ text: `${month + 1}月` }).style.gridColumn = `${col} / span 3`;
    }
    for (let offset = 0; offset < columns * 7; offset++) {
      const date = addDays(startGrid, offset);
      if (date < start || date >= end) grid.createSpan({ cls: "ja-pad", attr: { "aria-hidden": "true" } });
      else this.heatCell(grid, date, false);
    }
  }

  renderWeeklyHeat(scroll) {
    const grid = scroll.createDiv("ja-weeks");
    const end = firstWeek(this.year + 1);
    for (let date = firstWeek(this.year); date < end; date = addDays(date, 7)) {
      this.heatCell(grid, date, true);
    }
  }

  renderCalendar(parent) {
    const panel = parent.createEl("section", { cls: "ja-calendar", attr: { "aria-label": "月历" } });
    const header = panel.createDiv("ja-panel-header");
    const month = this.date.getUTCMonth();
    const year = this.date.getUTCFullYear();
    header.createEl("h2", { text: `${year} 年 ${month + 1} 月` });
    const nav = header.createDiv("ja-nav");
    this.button(nav, { icon: "chevron-left", label: "上个月", id: "previous-month", action: () => this.changeMonth(-1) });
    this.button(nav, { text: "今天", id: "today", action: () => this.select(this.kind, today()) });
    this.button(nav, { icon: "chevron-right", label: "下个月", id: "next-month", action: () => this.changeMonth(1) });

    const grid = panel.createDiv("ja-calendar-grid");
    ["周次", ...WEEKDAYS].forEach(day => grid.createSpan({ cls: "ja-calendar-label", text: day }));
    const first = dateAt(year, month);
    const start = weekStart(first);
    const end = dateAt(year, month + 1);
    const last = addDays(end, -1);
    for (let date = start; date < end; date = addDays(date, 7)) {
      const key = weekKey(date);
      const summary = this.getSummary("weekly", date);
      const week = this.button(grid, {
        cls: "ja-calendar-week", text: key.slice(5), id: `month-${key}`,
        label: `${key} · ${this.describe(summary)}`, action: () => {
          const thursday = addDays(date, 3);
          const visible = thursday < first ? first : thursday > last ? last : thursday;
          this.select("weekly", visible, `month-${key}`);
        }
      });
      this.mark(week, summary);
      week.setAttribute("aria-pressed", String(this.kind === "weekly" && key === weekKey(this.date)));
      for (let day = 0; day < 7; day++) {
        const dayDate = addDays(date, day);
        const dailyKey = dayKey(dayDate);
        const daily = this.getSummary("daily", dayDate);
        const id = `month-${dailyKey}`;
        const button = this.button(grid, {
          cls: "ja-calendar-day", text: String(dayDate.getUTCDate()), id,
          label: `${dailyKey} · ${this.describe(daily)}`,
          action: () => this.select("daily", dayDate, id)
        });
        this.mark(button, daily);
        button.classList.toggle("ja-outside", dayDate.getUTCMonth() !== month);
        button.classList.toggle("ja-current", dailyKey === dayKey(today()));
        button.setAttribute("aria-pressed", String(this.kind === "daily" && dailyKey === dayKey(this.date)));
      }
    }
  }

  renderDetails(parent) {
    const panel = parent.createEl("section", { cls: "ja-details", attr: { "aria-label": "笔记与板块记录" } });
    const summary = this.getSummary(this.kind, this.date);
    const name = KINDS[this.kind];
    const heading = panel.createDiv("ja-detail-header");
    heading.createDiv({ cls: "ja-kicker", text: name });
    heading.createEl("h2", { text: periodKey(this.kind, this.date) });
    if (this.kind === "weekly") {
      const monday = weekStart(this.date);
      const dailyNotes = Array.from({ length: 7 }, (_, index) => this.getSummary("daily", addDays(monday, index)));
      heading.createDiv({
        cls: "ja-muted",
        text: `${dayKey(monday).slice(5)} 至 ${dayKey(addDays(monday, 6)).slice(5)} · 本周 ${dailyNotes.filter(item => item.any).length}/7 天有日记内容`
      });
    }
    const list = panel.createEl("ul", { cls: "ja-statuses" });
    const states = { written: "已记录", blank: "空白", absent: "无此板块" };
    this.sections.forEach((section, index) => {
      const state = summary.statuses[index];
      const item = list.createEl("li", { cls: this.filter === index ? "ja-status-selected" : "" });
      item.createSpan({ text: section.label });
      item.createSpan({
        cls: `ja-status ja-${state}`,
        text: summary.notes.length ? states[state] : "无笔记"
      });
    });
    if (!this.sections.length) list.createEl("li", { cls: "ja-muted", text: "可在插件设置中添加要统计的板块。" });
    const actions = panel.createDiv("ja-actions");
    if (summary.notes.length) {
      summary.notes.forEach((note, index) => {
        this.button(actions, {
          icon: "file-text", text: summary.notes.length === 1 ? `打开${name}` : `打开${name} ${index + 1}`,
          label: note.path, id: `open-${index}`, action: () => void this.plugin.openNote(note.path)
        });
      });
    } else {
      this.button(actions, {
        icon: "plus", text: `新建${name}`, id: "create", action: () => void this.plugin.createNote(this.kind, this.date)
      });
    }
  }
}

module.exports = JournalAtlasPlugin;
