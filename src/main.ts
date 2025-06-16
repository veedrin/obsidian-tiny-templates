import { App, Plugin, Setting, TFile, TFolder, Modal, Notice, PluginSettingTab, SuggestModal, setIcon } from 'obsidian';

interface TinyTemplatesSettings {
  templateFolder: string;
  templates: Record<string, {
    name: string;
    targetFolder?: string;
    dateFields?: Record<string, boolean>;
    titleFormat?: string;
  }>;
}

const DEFAULT_SETTINGS: TinyTemplatesSettings = {
  templateFolder: '',
  templates: {}
};

// 内置属性，不作为日期字段
const EXCLUDED_FIELDS = ['tags', 'aliases', 'cssclasses'];

////////////////////
// 插件主体类
////////////////////
export default class TinyTemplates extends Plugin {
  settings: TinyTemplatesSettings;
  settingTab: TinyTemplatesSettingTab;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon(
      'zap',
      'Tiny Templates',
      () => new TinyTemplatesModal(this.app, this).open(),
    );

    // 先移除命令，再添加命令，确保幂等性
    // @ts-ignore
    this.app.commands.removeCommand(`${this.manifest.id}:open`);
    this.addCommand({
      id: 'open',
      name: 'Open',
      callback: () => new TinyTemplatesModal(this.app, this).open(),
    });

    this.settingTab = new TinyTemplatesSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async syncSettingsWithFileSystem() {
    const { templateFolder, templates } = this.settings;
    if (!templateFolder) {
      if (Object.keys(templates).length > 0) {
        this.settings.templates = {};
      }
      return;
    }

    const folder = this.app.vault.getAbstractFileByPath(templateFolder);
    if (!(folder instanceof TFolder)) {
      this.settings.templates = {};
      return;
    }

    const allTemplateFiles: TFile[] = [];
    const stack: TFolder[] = [folder];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const child of current.children) {
        if (child instanceof TFolder) {
          stack.push(child);
        } else if (child instanceof TFile) {
          allTemplateFiles.push(child);
        }
      }
    }

    const newTemplates: TinyTemplatesSettings['templates'] = {};

    for (const file of allTemplateFiles) {
      const path = file.path;
      const existingSettings = templates[path];
      
      newTemplates[path] = existingSettings || { name: file.basename };
      newTemplates[path].name = file.basename;

      if (newTemplates[path].dateFields) {
        const fileCache = this.app.metadataCache.getFileCache(file);
        const frontmatterKeys = fileCache?.frontmatter ? Object.keys(fileCache.frontmatter) : [];
        
        const newDateFields: Record<string, boolean> = {};
        for (const field in newTemplates[path].dateFields) {
          if (frontmatterKeys.includes(field)) {
            newDateFields[field] = newTemplates[path].dateFields![field];
          }
        }
        newTemplates[path].dateFields = newDateFields;
      }
    }

    this.settings.templates = newTemplates;
  }
}

////////////////////
// 模板选择弹窗
////////////////////
class TinyTemplatesModal extends Modal {
  plugin: TinyTemplates;
  templates: Map<string, { path: string, category: string }>;
  selectedTemplate: string | null;
  currentCategoryIndex: number;
  currentTemplateIndex: number;
  categorizedTemplates: Record<string, string[]>;
  sortedCategories: string[] = [];

  constructor(app: App, plugin: TinyTemplates) {
    super(app);
    this.plugin = plugin;
    this.templates = new Map();
    this.selectedTemplate = null;
    this.currentCategoryIndex = 0;
    this.currentTemplateIndex = 0;
    this.categorizedTemplates = {};
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    contentEl.createEl('h4', { text: '选择模板新建文件' });
    
    await this.loadTemplates();
    this.renderTemplateList();

    // 添加键盘导航
    this.scope.register([], 'Enter', (evt) => {
      if (this.selectedTemplate) {
        this.createFileFromTemplate(this.selectedTemplate);
        evt.preventDefault();
      }
    });

    // 垂直导航（类别间）
    this.scope.register([], 'ArrowUp', (evt) => {
      evt.preventDefault();
      this.navigateCategory(-1);
    });

    this.scope.register([], 'ArrowDown', (evt) => {
      evt.preventDefault();
      this.navigateCategory(1);
    });

    // 水平导航（类别内）
    this.scope.register([], 'ArrowLeft', (evt) => {
      evt.preventDefault();
      this.navigateWithinCategory(-1);
    });

    this.scope.register([], 'ArrowRight', (evt) => {
      evt.preventDefault();
      this.navigateWithinCategory(1);
    });
  }

  async loadTemplates() {
    this.templates.clear();
    this.categorizedTemplates = {};
    
    const templateFolder = this.plugin.settings.templateFolder;
    if (!templateFolder) {
      return;
    }

    const folder = this.app.vault.getAbstractFileByPath(templateFolder);
    if (!folder || !(folder instanceof TFolder)) {
      new Notice(`模板目录"${templateFolder}"不存在！`);
      return;
    }

    await this.scanFolder(folder, '', templateFolder);
    
    // 整理分类
    for (const [templatePath, templateInfo] of this.templates.entries()) {
      const category = templateInfo.category;
      if (!category) {
        if (!this.categorizedTemplates['']) {
          this.categorizedTemplates[''] = [];
        }
        this.categorizedTemplates[''].push(templatePath);
      } else {
        if (!this.categorizedTemplates[category]) {
          this.categorizedTemplates[category] = [];
        }
        this.categorizedTemplates[category].push(templatePath);
      }
    }

    // 对每个分类中的模板进行排序
    for (const category of Object.keys(this.categorizedTemplates)) {
      this.categorizedTemplates[category].sort((a, b) => {
        const aName = this.app.vault.getAbstractFileByPath(a)?.name || '';
        const bName = this.app.vault.getAbstractFileByPath(b)?.name || '';
        return aName.localeCompare(bName, 'zh-CN');
      });
    }

    // 保存排序后的分类列表
    this.sortedCategories = Object.keys(this.categorizedTemplates).sort((a, b) => {
      if (a === '') return -1;
      if (b === '') return 1;
      return a.localeCompare(b, 'zh-CN');
    });

    // 重置选择状态
    this.currentCategoryIndex = 0;
    this.currentTemplateIndex = 0;
    this.selectedTemplate = null;

    if (this.sortedCategories.length > 0) {
      const firstCategory = this.sortedCategories[0];
      if (this.categorizedTemplates[firstCategory]?.length > 0) {
        this.selectedTemplate = this.categorizedTemplates[firstCategory][0];
        this.currentCategoryIndex = 0;
        this.currentTemplateIndex = 0;
      }
    }
  }

  async scanFolder(folder: TFolder, category: string, basePath: string) {
    const isTemplateRoot = folder.path === this.plugin.settings.templateFolder;
    
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        await this.scanFolder(child, child.name, basePath);
      } else if (child instanceof TFile) {
        const relativePath = child.path.substring(basePath.length + (basePath.endsWith('/') ? 0 : 1));
        const templateCategory = isTemplateRoot ? '' : category;
        
        if (!this.plugin.settings.templates[child.path]) {
          this.plugin.settings.templates[child.path] = {
            name: child.basename
          };
        } else {
          this.plugin.settings.templates[child.path].name = child.basename;
        }
        
        this.templates.set(child.path, {
          path: child.path,
          category: templateCategory
        });
      }
    }
  }

  async checkTemplateDateFields(templatePath: string) {
    const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
    if (!(templateFile instanceof TFile)) {
      return {};
    }

    const fileCache = this.app.metadataCache.getFileCache(templateFile);
    if (!fileCache?.frontmatter) return {};

    const dateFields: Record<string, boolean> = {};

    // 使用 Obsidian API 获取所有属性
    for (const [fieldName, value] of Object.entries(fileCache.frontmatter)) {
      if (EXCLUDED_FIELDS.includes(fieldName)) continue;
      dateFields[fieldName] = false;
    }

    return dateFields;
  }

  renderTemplateList() {
    const { contentEl } = this;
    const templateListContainer = contentEl.createDiv({ cls: 'template-list' });

    // 使用已保存的排序分类列表
    this.sortedCategories.forEach((category, categoryIndex) => {
      const templatePaths = this.categorizedTemplates[category];
      if (category === '') {
        const templateCards = templateListContainer.createDiv({ cls: 'template-cards' });
        templatePaths.forEach((templatePath, templateIndex) => {
          this.renderTemplateCard(templateCards, templatePath, categoryIndex, templateIndex);
        });
      } else {
        const categoryEl = templateListContainer.createDiv({ cls: 'template-category' });
        categoryEl.createEl('h4', { text: category });
        
        const templateCards = categoryEl.createDiv({ cls: 'template-cards' });
        templatePaths.forEach((templatePath, templateIndex) => {
          this.renderTemplateCard(templateCards, templatePath, categoryIndex, templateIndex);
        });
      }
    });

    contentEl.createDiv({ cls: 'template-tail' });
  }

  private renderTemplateCard(container: HTMLElement, templatePath: string, categoryIndex: number, templateIndex: number) {
    const file = this.app.vault.getAbstractFileByPath(templatePath);
    if (!(file instanceof TFile)) return;

    const templateCard = container.createDiv({ 
      cls: `template-card ${this.selectedTemplate === templatePath ? 'selected' : ''}`,
      attr: {
        'data-template-path': templatePath,
        'data-category-index': categoryIndex.toString(),
        'data-template-index': templateIndex.toString()
      }
    });
    
    templateCard.createSpan({ text: file.basename });
    
    templateCard.addEventListener('mouseenter', () => {
      const cards = this.contentEl.querySelectorAll('.template-card');
      cards.forEach(card => card.removeClass('hover'));
      templateCard.addClass('hover');
    });
    
    templateCard.addEventListener('mouseleave', () => {
      templateCard.removeClass('hover');
    });
    
    templateCard.addEventListener('click', () => {
      this.selectTemplate(categoryIndex, templateIndex, templatePath);
      this.createFileFromTemplate(templatePath);
    });
  }

  selectTemplate(categoryIndex: number, templateIndex: number, templatePath: string) {
    const prevSelected = this.contentEl.querySelector('.template-card.selected');
    if (prevSelected) {
      prevSelected.removeClass('selected');
    }

    this.currentCategoryIndex = categoryIndex;
    this.currentTemplateIndex = templateIndex;
    this.selectedTemplate = templatePath;

    const newSelected = this.contentEl.querySelector(`.template-card[data-template-path="${templatePath}"]`);
    if (newSelected) {
      newSelected.addClass('selected');
      newSelected.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  navigateCategory(direction: number) {
    if (this.sortedCategories.length === 0) return;

    // 获取当前模板在当前分类中的索引
    const currentIndex = this.currentTemplateIndex;
    
    // 切换到上/下一个类别
    const newCategoryIndex = (this.currentCategoryIndex + direction + this.sortedCategories.length) % this.sortedCategories.length;
    const newTemplates = this.categorizedTemplates[this.sortedCategories[newCategoryIndex]] || [];
    
    if (newTemplates.length > 0) {
      // 尝试在新分类中选择相同位置的模板，如果不存在则选择第一个
      const templateIndex = Math.min(currentIndex, newTemplates.length - 1);
      this.selectTemplate(newCategoryIndex, templateIndex, newTemplates[templateIndex]);
    }
  }

  navigateWithinCategory(direction: number) {
    if (this.sortedCategories.length === 0) return;

    const currentCategoryTemplates = this.categorizedTemplates[this.sortedCategories[this.currentCategoryIndex]] || [];
    let newTemplateIndex = this.currentTemplateIndex + direction;
    let newCategoryIndex = this.currentCategoryIndex;

    // 如果超出当前类别范围，切换到上/下一个类别
    if (newTemplateIndex < 0) {
      // 向左到头，切换到上一个类别的最后一个模板
      newCategoryIndex = (newCategoryIndex - 1 + this.sortedCategories.length) % this.sortedCategories.length;
      const prevTemplates = this.categorizedTemplates[this.sortedCategories[newCategoryIndex]] || [];
      newTemplateIndex = prevTemplates.length - 1;
    } else if (newTemplateIndex >= currentCategoryTemplates.length) {
      // 向右到头，切换到下一个类别的第一个模板
      newCategoryIndex = (newCategoryIndex + 1) % this.sortedCategories.length;
      newTemplateIndex = 0;
    }

    const newTemplates = this.categorizedTemplates[this.sortedCategories[newCategoryIndex]] || [];
    if (newTemplates.length > 0) {
      this.selectTemplate(newCategoryIndex, newTemplateIndex, newTemplates[newTemplateIndex]);
    }
  }

  async createFileFromTemplate(templatePath: string) {
    const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
    if (!(templateFile instanceof TFile)) {
      new Notice(`模板"${templatePath}"不存在！`);
      return;
    }

    const templateSettings = this.plugin.settings.templates[templatePath];
    if (!templateSettings) {
      new Notice(`模板"${templatePath}"的配置项不存在！`);
      return;
    }

    // 获取目标目录
    const targetFolder = templateSettings.targetFolder || '';
    if (!targetFolder) {
      new Notice(`未设置"${templateFile.basename}"模板的目标目录！`);
      return;
    }

    // 检查目标目录是否存在
    const folder = this.app.vault.getAbstractFileByPath(targetFolder);
    if (!folder || !(folder instanceof TFolder)) {
      new Notice(`目标目录"${targetFolder}"不存在！`);
      return;
    }

    try {
      // 读取模板内容
      const content = await this.app.vault.read(templateFile);
      
      // 创建新文件，如果有预设标题格式则使用
      let fileName = `未命名.md`;
      
      // 处理预设标题格式
      if (templateSettings.titleFormat) {
        // 使用TitleFormatModal中的formatTitle方法生成标题
        const titleFormat = new TitleFormatModal(this.app, this.plugin, templatePath, templateFile.basename);
        const formattedTitle = titleFormat.formatTitle(templateSettings.titleFormat);
        if (formattedTitle) {
          fileName = `${formattedTitle}.md`;
        }
      }
      
      const filePath = `${targetFolder}/${fileName}`;
      const newFile = await this.app.vault.create(filePath, content);
      
      // 处理日期字段
      const dateFields = templateSettings.dateFields || {};
      if (Object.keys(dateFields).length > 0) {
        await this.app.fileManager.processFrontMatter(newFile, (frontmatter) => {
          // 使用本地时区的日期，而不是UTC
          const now = new Date();
          const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
          for (const [fieldName, shouldAutoSet] of Object.entries(dateFields)) {
            if (shouldAutoSet) {
              frontmatter[fieldName] = today;
            }
          }
        });
      }
      
      // 在新标签页打开新创建的文件
      const leaf = this.app.workspace.getLeaf('tab');
      await leaf.openFile(newFile);

      this.close();
    } catch (error) {
      new Notice(`新建文件失败：${error.message}`);
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

////////////////////
// 模板目录系统弹窗
////////////////////
class TemplateFolderSuggestModal extends SuggestModal<string> {
  private folders: string[];
  private onChoose: (folder: string) => void;

  constructor(app: App, folders: string[], onChoose: (folder: string) => void) {
    super(app);
    this.folders = folders;
    this.onChoose = onChoose;
  }

  getSuggestions(query: string): string[] {
    const lowerQuery = query.toLowerCase();
    return this.folders.filter(folder => {
      const folderObj = this.app.vault.getAbstractFileByPath(folder);
      if (!(folderObj instanceof TFolder)) return false;

      // 只显示一级目录
      const pathParts = folder.split('/');
      const isRootLevel = pathParts.length === 1;

      return isRootLevel && folder.toLowerCase().contains(lowerQuery);
    });
  }

  renderSuggestion(folder: string, el: HTMLElement) {
    el.createEl("div", { text: folder });
  }

  onChooseSuggestion(folder: string, evt: MouseEvent | KeyboardEvent) {
    this.onChoose(folder);
    this.close();
  }
}

////////////////////
// 目标目录系统弹窗
////////////////////
class TargetFolderSuggestModal extends SuggestModal<string> {
  private folders: string[];
  private onChoose: (folder: string) => void;

  constructor(app: App, folders: string[], onChoose: (folder: string) => void) {
    super(app);
    this.folders = folders;
    this.onChoose = onChoose;
  }

  getSuggestions(query: string): string[] {
    const lowerQuery = query.toLowerCase();
    return this.folders.filter(folder => {
      const folderObj = this.app.vault.getAbstractFileByPath(folder);
      if (!(folderObj instanceof TFolder)) return false;
      return folder.toLowerCase().contains(lowerQuery);
    });
  }

  renderSuggestion(folder: string, el: HTMLElement) {
    el.createEl("div", { text: folder });
  }

  onChooseSuggestion(folder: string, evt: MouseEvent | KeyboardEvent) {
    this.onChoose(folder);
    this.close();
  }
}

////////////////////
// Obsidian 设置页
////////////////////
class TinyTemplatesSettingTab extends PluginSettingTab {
  plugin: TinyTemplates;
  templateFolders: Map<string, string[]> = new Map();
  templates: Map<string, { path: string, category: string }> = new Map();
  
  constructor(app: App, plugin: TinyTemplates) {
    super(app, plugin);
    this.plugin = plugin;
  }
  
  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    
    // 同步配置
    await this.plugin.syncSettingsWithFileSystem();
    await this.plugin.saveSettings();
    
    containerEl.createEl('h2', { text: 'Tiny Templates Settings' });
    
    // 创建模板目录选择区域
    const templateChoosingContainer = containerEl.createDiv({ cls: 'template-choosing-container' });
    const chooseFolderSetting = new Setting(templateChoosingContainer)
      .addButton(button => button
        .setButtonText('选择模板目录')
        .setCta()
        .onClick(async () => {
          const folders: string[] = [];
          this.app.vault.getAllLoadedFiles().forEach(file => {
            if (file instanceof TFolder) {
              folders.push(file.path);
            }
          });

          new TemplateFolderSuggestModal(this.app, folders, async (folder) => {
            this.plugin.settings.templateFolder = folder;
            await this.plugin.saveSettings();
            this.display();
          }).open();
        }))
      .setDesc(`模板目录：${this.plugin.settings.templateFolder}` || '未选择目录');

    // 调整样式
    chooseFolderSetting.settingEl.addClass('template-folder-setting');
    chooseFolderSetting.infoEl.style.order = '2';  // 让描述显示在右边
    chooseFolderSetting.controlEl.style.order = '1';  // 让按钮显示在左边
    
    if (this.plugin.settings.templateFolder) {
      await this.scanTemplates();
      this.displayTemplateSettings();
    }
  }
  
  async scanTemplates() {
    const templateFolder = this.plugin.settings.templateFolder;
    if (!templateFolder) return;
    
    const folder = this.app.vault.getAbstractFileByPath(templateFolder);
    if (!folder || !(folder instanceof TFolder)) {
      new Notice(`模板目录"${templateFolder}"不存在！`);
      return;
    }
    
    this.templateFolders = new Map();
    this.templates = new Map();
    const allFolderPaths: string[] = [];
    
    // 获取库中所有文件夹
    this.app.vault.getAllLoadedFiles().forEach(file => {
      if (file instanceof TFolder) {
        allFolderPaths.push(file.path);
      }
    });
    
    // 扫描模板文件夹及其子文件夹
    await this.scanFolder(folder, '', allFolderPaths);
  }
  
  async scanFolder(folder: TFolder, category: string, allFolderPaths: string[]) {
    // 判断是否是模板根目录
    const isTemplateRoot = folder.path === this.plugin.settings.templateFolder;
    
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        // 如果是文件夹，则作为新的分类继续扫描
        const newCategory = category ? `${category}/${child.name}` : child.name;
        await this.scanFolder(child, newCategory, allFolderPaths);
      } else if (child instanceof TFile) {
        // 如果是文件，则添加为模板
        this.templateFolders.set(child.path, allFolderPaths);
        
        // 如果是在模板根目录下，则不设置分类
        const templateCategory = isTemplateRoot ? '' : category;
        
        // 确保模板设置存在
        if (!this.plugin.settings.templates[child.path]) {
          this.plugin.settings.templates[child.path] = {
            name: child.basename
          };
        } else {
          // 更新名称，保留其他设置
          this.plugin.settings.templates[child.path].name = child.basename;
        }
        
        this.templates.set(child.basename, {
          path: child.path,
          category: templateCategory
        });
        
        // 添加到 templateFolders
        this.templateFolders.set(child.path, allFolderPaths);
      }
    }
  }
  
  async checkTemplateDateFields(templatePath: string) {
    const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
    if (!(templateFile instanceof TFile)) {
      return {};
    }

    const fileCache = this.app.metadataCache.getFileCache(templateFile);
    if (!fileCache?.frontmatter) return {};

    const dateFields: Record<string, boolean> = {};

    // 使用 Obsidian API 获取所有属性
    for (const [fieldName, value] of Object.entries(fileCache.frontmatter)) {
      if (EXCLUDED_FIELDS.includes(fieldName)) continue;
      dateFields[fieldName] = false;
    }

    return dateFields;
  }
  
  displayTemplateSettings() {
    const { containerEl } = this;
    
    // 创建标题和容器
    containerEl.createEl('h4', { cls: 'template-settings-title', text: '所有模板' });
    const allTemplatesContainer = containerEl.createDiv({ cls: 'template-settings-container' });
    
    // 按分类组织模板
    const categorizedTemplates: Record<string, { path: string, basename: string }[]> = {};
    const uncategorizedTemplates: { path: string, basename: string }[] = [];
    
    // 遍历所有模板
    for (const [basename, templateInfo] of this.templates) {
      const templatePath = templateInfo.path;
      const category = templateInfo.category;
      
      if (!category) {
        uncategorizedTemplates.push({
          path: templatePath,
          basename: basename
        });
      } else {
        if (!categorizedTemplates[category]) {
          categorizedTemplates[category] = [];
        }
        categorizedTemplates[category].push({
          path: templatePath,
          basename: basename
        });
      }
    }

    // 对未分类模板进行排序
    uncategorizedTemplates.sort((a, b) => a.basename.localeCompare(b.basename, 'zh-CN'));

    // 对每个分类中的模板进行排序
    for (const templates of Object.values(categorizedTemplates)) {
      templates.sort((a, b) => a.basename.localeCompare(b.basename, 'zh-CN'));
    }

    // 先显示未分类的模板
    if (uncategorizedTemplates.length > 0) {
      const templateGroup = allTemplatesContainer.createDiv({ cls: 'template-settings-group' });
      this.renderTemplateGroup(templateGroup, uncategorizedTemplates);
    }
    
    // 按分类名称排序并显示分类的模板
    const sortedCategories = Object.entries(categorizedTemplates).sort(([a], [b]) => a.localeCompare(b, 'zh-CN'));
    for (const [category, templates] of sortedCategories) {
      allTemplatesContainer.createEl('h6', { text: category });
      const templateGroup = allTemplatesContainer.createDiv({ cls: 'template-settings-group' });
      this.renderTemplateGroup(templateGroup, templates);
    }
  }

  private renderTemplateGroup(container: HTMLElement, templates: { path: string, basename: string }[]) {
    const templateCardsContainer = container.createDiv({ cls: 'template-setting-cards-container' });
    
    for (const template of templates) {
      // 创建模板卡片容器
      const templateCard = templateCardsContainer.createDiv({ cls: 'template-setting-card' });
      
      // 创建模板名称
      const nameEl = templateCard.createDiv({ cls: 'template-setting-card-name', text: template.basename });
      
      // 创建按钮容器
      const buttonContainer = templateCard.createDiv({ cls: 'template-setting-card-buttons' });
      
      // 目标目录按钮
      const targetButton = buttonContainer.createDiv({ cls: 'template-setting-card-button' });
      const targetFolder = this.plugin.settings.templates[template.path]?.targetFolder;
      const tooltipText = targetFolder ? `目标目录：${targetFolder}` : '选择目标目录';
      
      const targetIcon = targetButton.createEl('span', { cls: 'clickable-icon action-icon' + (targetFolder ? ' action-active' : '') });
      setIcon(targetIcon, 'target');
      targetIcon.setAttribute('aria-label', tooltipText);
      
      targetIcon.addEventListener('click', async () => {
        const folders: string[] = [];
        this.app.vault.getAllLoadedFiles().forEach(file => {
          if (file instanceof TFolder) {
            folders.push(file.path);
          }
        });

        new TargetFolderSuggestModal(this.app, folders, async (folder) => {
          if (!this.plugin.settings.templates[template.path]) {
            this.plugin.settings.templates[template.path] = {
              name: template.basename
            };
          }
          this.plugin.settings.templates[template.path].targetFolder = folder;
          await this.plugin.saveSettings();
          this.display();
        }).open();
      });
      
      // 预设标题按钮
      const titleButton = buttonContainer.createDiv({ cls: 'template-setting-card-button' });
      const hasTitleFormat = !!this.plugin.settings.templates[template.path]?.titleFormat;
      
      const titleIcon = titleButton.createEl('span', { cls: 'clickable-icon action-icon' + (hasTitleFormat ? ' action-active' : '') });
      setIcon(titleIcon, 'heading');
      titleIcon.setAttribute('aria-label', '预设标题格式');
      
      titleIcon.addEventListener('click', () => {
        new TitleFormatModal(
          this.app,
          this.plugin,
          template.path,
          template.basename
        ).open();
      });
      
      // 日期字段按钮
      const dateButton = buttonContainer.createDiv({ cls: 'template-setting-card-button' });
      const hasDateFields = Object.keys(this.plugin.settings.templates[template.path]?.dateFields || {}).length > 0;
      
      const dateIcon = dateButton.createEl('span', { cls: 'clickable-icon action-icon' + (hasDateFields ? ' action-active' : '') });
      setIcon(dateIcon, 'calendar');
      dateIcon.setAttribute('aria-label', '填充日期属性为当天');
      
      dateIcon.addEventListener('click', () => {
        new DateFieldsModal(
          this.app,
          this.plugin,
          template.path,
          template.basename
        ).open();
      });
    }
  }
}

////////////////////
// 预设标题弹窗
////////////////////
class TitleFormatModal extends Modal {
  plugin: TinyTemplates;
  templatePath: string;
  templateName: string;
  titleFormat: string;
  previewEl: HTMLElement;

  constructor(app: App, plugin: TinyTemplates, templatePath: string, templateName: string) {
    super(app);
    this.plugin = plugin;
    this.templatePath = templatePath;
    this.templateName = templateName;
    this.titleFormat = this.plugin.settings.templates[templatePath]?.titleFormat || '';
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h4', { text: '预设标题格式' });

    // 输入框
    const inputContainer = contentEl.createDiv({ cls: 'title-format-input-container' });
    const inputEl = inputContainer.createEl('input', {
      type: 'text',
      value: this.titleFormat,
      cls: 'title-format-input'
    });

    // 预览区域
    const previewContainer = contentEl.createDiv({ cls: 'title-format-preview-container' });
    previewContainer.createEl('div', { text: '预览：', cls: 'title-format-preview-label' });
    this.previewEl = previewContainer.createEl('div', { cls: 'title-format-preview-content' });
    
    // 更新预览
    const updatePreview = () => {
      const format = inputEl.value;
      const preview = this.formatTitle(format);
      this.previewEl.setText(preview);
      this.titleFormat = format;
    };
    
    // 输入事件
    inputEl.addEventListener('input', updatePreview);
    
    // 变量选项
    const variablesContainer = contentEl.createDiv({ cls: 'title-format-variables-container' });
    variablesContainer.createEl('div', { text: '变量选项（点击即可插入）', cls: 'title-format-variables-label' });
    
    const variables = [
      { key: '{{date}}', desc: '当前日期（YYYY-MM-DD格式）' },
      { key: '{{year}}', desc: '年份（YYYY格式）' },
      { key: '{{quarter}}', desc: '季度（1-4）' },
      { key: '{{month}}', desc: '月份（MM格式）' },
      { key: '{{week}}', desc: '周数（1-52）' },
      { key: '{{weekday}}', desc: '星期（一、二、三、四、五、六、日）' },
      { key: '{{day}}', desc: '日（DD格式）' }
    ];
    
    for (const variable of variables) {
      const varCard = variablesContainer.createDiv({ cls: 'title-format-variable-card' });
      varCard.createSpan({ text: variable.key, cls: 'title-format-variable-key' });
      varCard.createSpan({ text: variable.desc, cls: 'title-format-variable-desc' });
      
      // 点击变量插入到输入框
      varCard.addEventListener('click', () => {
        const cursorPos = inputEl.selectionStart || 0;
        const textBefore = inputEl.value.substring(0, cursorPos);
        const textAfter = inputEl.value.substring(cursorPos);
        inputEl.value = textBefore + variable.key + textAfter;
        
        // 设置光标位置
        const newCursorPos = cursorPos + variable.key.length;
        inputEl.setSelectionRange(newCursorPos, newCursorPos);
        inputEl.focus();
        
        // 更新预览
        updatePreview();
      });
    }
    
    // 保存按钮
    const buttonContainer = contentEl.createDiv({ cls: 'title-format-button-container' });
    const saveButton = buttonContainer.createEl('button', { text: '保存', cls: 'mod-cta' });
    
    saveButton.addEventListener('click', async () => {
      if (!this.plugin.settings.templates[this.templatePath]) {
        this.plugin.settings.templates[this.templatePath] = {
          name: this.templateName
        };
      }
      
      this.plugin.settings.templates[this.templatePath].titleFormat = this.titleFormat;
      await this.plugin.saveSettings();
      
      // 如果是从设置页面打开的，刷新设置页面以更新按钮状态
      if (this.plugin.settingTab) {
        this.plugin.settingTab.display();
      }
      
      this.close();
    });
    
    // 初始化预览
    updatePreview();
  }
  
  /**
   * 根据格式和当前日期生成标题
   */
  formatTitle(format: string): string {
    if (!format) return ''; 
    
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const date = `${year}-${month}-${day}`;
    
    // 计算季度
    const quarter = Math.floor((now.getMonth() + 3) / 3);
    
    // 计算周数（一年中的第几周）
    const firstDayOfYear = new Date(year, 0, 1);
    const pastDaysOfYear = (now.getTime() - firstDayOfYear.getTime()) / 86400000;
    const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
    const week = String(weekNum).padStart(2, '0'); // 格式化为两位数
    
    // 星期（中文数字表示）
    const chineseWeekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const weekday = chineseWeekdays[now.getDay()];
    
    // 替换变量
    let result = format;
    result = result.replace(/\{\{date\}\}/g, date);
    result = result.replace(/\{\{year\}\}/g, String(year));
    result = result.replace(/\{\{quarter\}\}/g, String(quarter));
    result = result.replace(/\{\{month\}\}/g, month);
    result = result.replace(/\{\{week\}\}/g, week);
    result = result.replace(/\{\{weekday\}\}/g, weekday);
    result = result.replace(/\{\{day\}\}/g, day);
    
    return result;
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

////////////////////
// 设置日期为当天弹窗
////////////////////
class DateFieldsModal extends Modal {
  plugin: TinyTemplates;
  templatePath: string;
  templateName: string;
  fields: string[] = [];
  dateFields: Record<string, boolean> = {};

  constructor(app: App, plugin: TinyTemplates, templatePath: string, templateName: string) {
    super(app);
    this.plugin = plugin;
    this.templatePath = templatePath;
    this.templateName = templateName;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // 标题
    contentEl.createEl('h4', { text: '新建文件时将日期属性自动填充为当天' });
    contentEl.createEl('p', { 
      text: '插件无法判断哪些为日期属性，请用户自行选择',
      cls: 'setting-item-description'
    });

    // 获取模板内容和元数据
    const templateFile = this.app.vault.getAbstractFileByPath(this.templatePath);
    if (!(templateFile instanceof TFile)) return;

    const fileCache = this.app.metadataCache.getFileCache(templateFile);
    if (!fileCache?.frontmatter) return;

    const fieldsContainer = contentEl.createDiv({ cls: 'fields-container' });
    
    // 获取所有属性并排序
    const sortedFields = Object.entries(fileCache.frontmatter)
      .filter(([fieldName]) => !EXCLUDED_FIELDS.includes(fieldName))
      .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'));
    
    // 使用排序后的属性创建设置项
    for (const [fieldName] of sortedFields) {
      this.fields.push(fieldName);
      
      // 创建属性设置项
      const fieldSetting = new Setting(fieldsContainer)
        .setName(fieldName)
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.templates[this.templatePath]?.dateFields?.[fieldName] || false)
          .onChange(async (value) => {
            this.dateFields[fieldName] = value;
          }));
      
      fieldSetting.settingEl.addClass('field-setting');
    }

    // 如果没有检测到任何字段，显示提示
    if (this.fields.length === 0) {
      fieldsContainer.createEl('p', {
        text: '此模板没有任何属性。',
        cls: 'setting-item-description'
      });
    }

    // 保存按钮
    const buttonContainer = contentEl.createDiv({ cls: 'button-container' });
    const saveButton = buttonContainer.createEl('button', { text: '保存' });
    saveButton.addEventListener('click', async () => {
      // 更新设置
      if (!this.plugin.settings.templates[this.templatePath]) {
        this.plugin.settings.templates[this.templatePath] = {
          name: this.templateName
        };
      }

      const currentFields = this.plugin.settings.templates[this.templatePath]?.dateFields || {};
      const updatedFields = { ...currentFields, ...this.dateFields };

      // 清理掉所有值为 false 的字段，只保留 true 的
      const finalFields: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(updatedFields)) {
        if (value) {
          finalFields[key] = true;
        }
      }

      this.plugin.settings.templates[this.templatePath].dateFields = finalFields;
      
      await this.plugin.saveSettings();
      this.close();
      
      // 刷新设置页面
      if (this.plugin.settingTab) {
        this.plugin.settingTab.display();
      }
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
