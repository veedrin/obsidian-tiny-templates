import { App, Plugin, Setting, TFile, TFolder, Modal, Notice, PluginSettingTab, SuggestModal } from 'obsidian';

interface TinyTemplatesSettings {
    templateFolder: string;
    templates: Record<string, {
        name: string;
        targetFolder?: string;
        dateFields?: Record<string, boolean>;
        isCommandRegistered?: boolean;
    }>;
}

const DEFAULT_SETTINGS: TinyTemplatesSettings = {
    templateFolder: '',
    templates: {}
};

// 内置属性，不作为日期字段
const EXCLUDED_FIELDS = ['tags', 'aliases', 'cssclasses'];

export default class TinyTemplates extends Plugin {
    settings: TinyTemplatesSettings;
    settingTab: TinyTemplatesSettingTab;

    async onload() {
        await this.loadSettings();

        this.addRibbonIcon('zap', 'Tiny Templates', () => new TinyTemplatesModal(this.app, this).open());

        this.addCommand({
            id: 'open',
            name: 'Open Tiny Templates',
            callback: () => new TinyTemplatesModal(this.app, this).open(),
        });

        // 注册所有已保存的模板命令
        for (const [templatePath, templateSettings] of Object.entries(this.settings.templates)) {
            if (templateSettings.isCommandRegistered) {
                this.addCommand({
                    id: `create-from-template-${templatePath}`,
                    name: templateSettings.name,
                    callback: () => {
                        const modal = new TinyTemplatesModal(this.app, this);
                        modal.createFileFromTemplate(templatePath);
                    }
                });
            }
        }

        this.settingTab = new TinyTemplatesSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class TinyTemplatesModal extends Modal {
    plugin: TinyTemplates;
    templates: Map<string, { path: string, category: string }>;
    selectedTemplate: string | null;
    currentCategoryIndex: number;
    currentTemplateIndex: number;
    categorizedTemplates: Record<string, string[]>;

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
        
        contentEl.createEl('h3', { text: '选择模板新建文件' });
        
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

        // 设置初始选择
        const categories = Object.keys(this.categorizedTemplates).sort((a, b) => {
            if (a === '') return -1;
            if (b === '') return 1;
            return a.localeCompare(b, 'zh-CN');
        });

        // 重置选择状态
        this.currentCategoryIndex = 0;
        this.currentTemplateIndex = 0;
        this.selectedTemplate = null;

        if (categories.length > 0) {
            const firstCategory = categories[0];
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

        // 获取已排序的分类
        const categories = Object.keys(this.categorizedTemplates).sort((a, b) => {
            if (a === '') return -1;
            if (b === '') return 1;
            return a.localeCompare(b, 'zh-CN');
        });

        // 遍历排序后的分类
        categories.forEach((category, categoryIndex) => {
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
        const categories = Object.keys(this.categorizedTemplates);
        if (categories.length === 0) return;

        // 切换到上/下一个类别的第一个模板
        const newCategoryIndex = (this.currentCategoryIndex + direction + categories.length) % categories.length;
        const newTemplates = this.categorizedTemplates[categories[newCategoryIndex]] || [];
        
        if (newTemplates.length > 0) {
            // 如果是向上导航，选择最后一个模板
            const templateIndex = direction < 0 ? newTemplates.length - 1 : 0;
            this.selectTemplate(newCategoryIndex, templateIndex, newTemplates[templateIndex]);
        }
    }

    navigateWithinCategory(direction: number) {
        const categories = Object.keys(this.categorizedTemplates);
        if (categories.length === 0) return;

        const currentCategoryTemplates = this.categorizedTemplates[categories[this.currentCategoryIndex]] || [];
        let newTemplateIndex = this.currentTemplateIndex + direction;
        let newCategoryIndex = this.currentCategoryIndex;

        // 如果超出当前类别范围，切换到上/下一个类别
        if (newTemplateIndex < 0) {
            // 向左到头，切换到上一个类别的最后一个模板
            newCategoryIndex = (newCategoryIndex - 1 + categories.length) % categories.length;
            const prevTemplates = this.categorizedTemplates[categories[newCategoryIndex]] || [];
            newTemplateIndex = prevTemplates.length - 1;
        } else if (newTemplateIndex >= currentCategoryTemplates.length) {
            // 向右到头，切换到下一个类别的第一个模板
            newCategoryIndex = (newCategoryIndex + 1) % categories.length;
            newTemplateIndex = 0;
        }

        const newTemplates = this.categorizedTemplates[categories[newCategoryIndex]] || [];
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
            
            // 创建新文件
            const fileName = `未命名.md`;
            const filePath = `${targetFolder}/${fileName}`;
            const newFile = await this.app.vault.create(filePath, content);
            
            // 处理日期字段
            const dateFields = templateSettings.dateFields || {};
            if (Object.keys(dateFields).length > 0) {
                await this.app.fileManager.processFrontMatter(newFile, (frontmatter) => {
                    const today = new Date().toISOString().slice(0, 10);
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

            new Notice(`已新建文件：${filePath}`);
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
        
        containerEl.createEl('h2', { text: 'Tiny Templates Settings' });
        
        // 创建模板目录选择区域
        const templateChoosingContainer = containerEl.createDiv({ cls: 'template-choosing-container' });
        const chooseFolderSetting = new Setting(templateChoosingContainer)
            .addButton(button => button
                .setButtonText('模板目录')
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
            .setDesc(this.plugin.settings.templateFolder || '未选择目录');

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
        containerEl.createEl('h3', { cls: 'template-settings-title', text: '所有模板' });
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
            allTemplatesContainer.createEl('h4', { text: category });
            const templateGroup = allTemplatesContainer.createDiv({ cls: 'template-settings-group' });
            this.renderTemplateGroup(templateGroup, templates);
        }
    }

    private renderTemplateGroup(container: HTMLElement, templates: { path: string, basename: string }[]) {
        for (const template of templates) {
            const templateSetting = new Setting(container)
                .setName(template.basename)
                .addExtraButton(button => {
                    button
                        .setIcon('target')
                        .setTooltip(this.plugin.settings.templates[template.path]?.targetFolder || '选择目标目录')
                        .onClick(async () => {
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

                    // 添加自定义样式
                    const iconEl = button.extraSettingsEl;
                    if (iconEl) {
                        iconEl.addClass('action-icon');
                        if (this.plugin.settings.templates[template.path]?.targetFolder) {
                            iconEl.addClass('action-active');
                        }
                    }
                    
                    return button;
                })
                .addExtraButton(button => {
                    const commandId = `create-from-template-${template.path}`;
                    // @ts-ignore - 访问私有 API
                    const commandExists = this.plugin.app.commands.commands[`${this.plugin.manifest.id}:${commandId}`] !== undefined;
                    const isRegistered = this.plugin.settings.templates[template.path]?.isCommandRegistered;

                    button
                        .setIcon('zap')
                        .setTooltip(isRegistered ? '从命令列表中移除' : '添加到命令列表')
                        .onClick(async () => {
                            if (isRegistered) {
                                // 取消注册命令
                                if (!this.plugin.settings.templates[template.path]) {
                                    this.plugin.settings.templates[template.path] = {
                                        name: template.basename
                                    };
                                }
                                this.plugin.settings.templates[template.path].isCommandRegistered = false;
                                await this.plugin.saveSettings();
                                
                                // 移除命令
                                // @ts-ignore - 访问私有 API
                                const commands = this.plugin.app.commands;
                                const commandId = `${this.plugin.manifest.id}:create-from-template-${template.path}`;
                                commands.removeCommand(commandId);
                                
                                // 更新图标状态
                                button.extraSettingsEl?.removeClass('action-active');
                                new Notice(`已将模板 ${template.basename} 从命令列表中移除`);
                            } else {
                                // 注册新命令
                                if (!this.plugin.settings.templates[template.path]) {
                                    this.plugin.settings.templates[template.path] = {
                                        name: template.basename
                                    };
                                }
                                this.plugin.settings.templates[template.path].isCommandRegistered = true;
                                await this.plugin.saveSettings();

                                this.plugin.addCommand({
                                    id: `create-from-template-${template.path}`,
                                    name: template.basename,
                                    callback: () => {
                                        const modal = new TinyTemplatesModal(this.app, this.plugin);
                                        modal.createFileFromTemplate(template.path);
                                    }
                                });
                                
                                // 更新图标状态
                                button.extraSettingsEl?.addClass('action-active');
                                new Notice(`已将模板 ${template.basename} 添加到命令列表\n现在可以为该模板配置快捷键了`);
                            }
                        });

                    // 添加自定义样式
                    const iconEl = button.extraSettingsEl;
                    if (iconEl) {
                        iconEl.addClass('action-icon');
                        if (isRegistered) {
                            iconEl.addClass('action-active');
                        }
                    }
                    
                    return button;
                })
                .addExtraButton(button => {
                    button
                        .setIcon('calendar')
                        .setTooltip('填充日期属性为当天')
                        .onClick(() => {
                            new DateFieldsModal(
                                this.app,
                                this.plugin,
                                template.path,
                                template.basename
                            ).open();
                        });

                    const iconEl = button.extraSettingsEl;
                    if (iconEl) {
                        iconEl.addClass('action-icon');
                        if (Object.keys(this.plugin.settings.templates[template.path]?.dateFields || {}).length > 0) {
                            iconEl.addClass('action-active');
                        }
                    }
                    
                    return button;
                });
        }
    }
}

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
        contentEl.createEl('h3', { text: '新建文件时将日期属性自动填充为当天' });
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
            
            this.plugin.settings.templates[this.templatePath].dateFields = {
                ...this.plugin.settings.templates[this.templatePath].dateFields,
                ...this.dateFields
            };
            
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
