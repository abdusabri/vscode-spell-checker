import { performance } from '../util/perf';
performance.mark('settings.ts');
import { CSpellUserSettings, normalizeLocal } from '../server';
import * as CSpellSettings from './CSpellSettings';
import { workspace, ConfigurationTarget } from 'vscode';
performance.mark('settings.ts imports 1');
import * as path from 'path';
import { Uri } from 'vscode';
import * as vscode from 'vscode';
performance.mark('settings.ts imports 2');
import { unique, uniqueFilter } from '../util';
import * as watcher from '../util/watcher';
import * as config from './config';
performance.mark('settings.ts imports 3');
import * as fs from 'fs-extra';
import { InspectScope } from './config';
performance.mark('settings.ts imports 4');
performance.mark('settings.ts imports done');

export { ConfigTarget, InspectScope, Scope } from './config';

export const baseConfigName        = CSpellSettings.defaultFileName;
export const configFileLocations = [
    baseConfigName,
    baseConfigName.toLowerCase(),
    `.vscode/${baseConfigName}`,
    `.vscode/${baseConfigName.toLowerCase()}`,
];

export interface SettingsInfo {
    path: string;
    settings: CSpellUserSettings;
}

export function watchSettingsFiles(callback: () => void): vscode.Disposable {
    // Every 10 seconds see if we have new files to watch.
    let busy = false;
    const intervalObj = setInterval(async () => {
        if (busy) {
            return;
        }
        busy = true;
        const settingsFiles = await findSettingsFiles();
        settingsFiles
            .map(uri => uri.fsPath)
            .filter(file => !watcher.isWatching(file))
            .forEach(file => watcher.add(file, callback));
        busy = false;
    }, 10000);

    return vscode.Disposable.from({ dispose: () => {
        watcher.dispose();
        clearInterval(intervalObj);
    } });
}

export function getDefaultWorkspaceConfigLocation() {
    const { workspaceFolders } = workspace;
    const root = workspaceFolders
        && workspaceFolders[0]
        && workspaceFolders[0].uri.fsPath;
    return root
        ? path.join(root, baseConfigName)
        : undefined;
}

export function hasWorkspaceLocation() {
    const { workspaceFolders } = workspace;
    return !!(workspaceFolders && workspaceFolders[0]);
}

export function findSettingsFiles(uri?: Uri): Thenable<Uri[]> {
    const { workspaceFolders } = workspace;
    if (!workspaceFolders || !hasWorkspaceLocation()) {
        return Promise.resolve([]);
    }

    const folders = uri
        ? [workspace.getWorkspaceFolder(uri)!].filter(a => !!a)
        : workspaceFolders;

    const possibleLocations = folders
        .map(folder => folder.uri.fsPath)
        .map(root => configFileLocations.map(rel => path.join(root, rel)))
        .reduce((a, b) => a.concat(b));

    const found = possibleLocations
        .map(filename => fs.pathExists(filename)
        .then(exists => ({ filename, exists })));

    return Promise.all(found).then(found => found
        .filter(found => found.exists)
        .map(found => found.filename)
        .map(filename => Uri.file(filename))
    );
}

export function findExistingSettingsFileLocation(uri?: Uri): Thenable<string | undefined> {
    return findSettingsFiles(uri)
    .then(uris => uris.map(uri => uri.fsPath))
    .then(paths => paths[0]);
}

export function findSettingsFileLocation(): Thenable<string | undefined> {
    return findExistingSettingsFileLocation()
        .then(path => path || getDefaultWorkspaceConfigLocation());
}

export function loadTheSettingsFile(): Thenable<SettingsInfo | undefined> {
    return findSettingsFileLocation()
        .then(loadSettingsFile);
}

export function loadSettingsFile(path: string): Thenable<SettingsInfo | undefined> {
    return path
        ? CSpellSettings.readSettings(path).then(settings => (path ? { path, settings } : undefined))
        : Promise.resolve(undefined);
}

export function setEnableSpellChecking(target: config.ConfigTarget, enabled: boolean): Thenable<void> {
    return config.setSettingInVSConfig('enabled', enabled, target);
}

export function getEnabledLanguagesFromConfig(scope: InspectScope) {
    return config.getScopedSettingFromVSConfig('enabledLanguageIds', scope) || [];
}

/**
 * @description Enable a programming language
 * @param target - which level of setting to set
 * @param languageId - the language id, e.g. 'typescript'
 */
export async function enableLanguage(target: config.ConfigTarget, languageId: string): Promise<void> {
    await enableLanguageIdForTarget(languageId, true, target, true);
}

export async function disableLanguage(target: config.ConfigTarget, languageId: string): Promise<void> {
    await enableLanguageIdForTarget(languageId, false, target, true);
}

export function addWordToSettings(target: config.ConfigTarget, word: string) {
    const useGlobal = config.isGlobalTarget(target) || !hasWorkspaceLocation();
    const addWords = word.split(' ');
    const section: 'userWords' | 'words' = useGlobal ? 'userWords' : 'words';
    return updateSettingInConfig(
        section,
        target,
        words => unique(addWords.concat(words || []).sort()),
        true
    );
}

export function addIgnoreWordToSettings(target: config.ConfigTarget, word: string) {
    const addWords = word.split(' ');
    return updateSettingInConfig(
        'ignoreWords',
        target,
        words => unique(addWords.concat(words || []).sort()),
        true
    );
}

export async function removeWordFromSettings(target: config.ConfigTarget, word: string) {
    const useGlobal = config.isGlobalTarget(target);
    const section: 'userWords' | 'words' = useGlobal ? 'userWords' : 'words';
    const toRemove = word.split(' ');
    return updateSettingInConfig(
        section,
        target,
        words => CSpellSettings.filterOutWords(words || [], toRemove),
        true
    );
}



export function toggleEnableSpellChecker(target: config.ConfigTarget): Thenable<void> {
    const resource = config.isConfigTargetWithResource(target) ? target.uri : null;
    const curr = config.getSettingFromVSConfig('enabled', resource);
    return config.setSettingInVSConfig('enabled', !curr, target);
}

/**
 * Enables the current programming language of the active file in the editor.
 */
export function enableCurrentLanguage(): Thenable<void> {
    const editor = vscode.window && vscode.window.activeTextEditor;
    if (editor && editor.document && editor.document.languageId) {
        const target = config.createTargetForDocument(ConfigurationTarget.WorkspaceFolder, editor.document);
        return enableLanguage(target, editor.document.languageId);
    }
    return Promise.resolve();
}

/**
 * Disables the current programming language of the active file in the editor.
 */
export function disableCurrentLanguage(): Thenable<void> {
    const editor = vscode.window && vscode.window.activeTextEditor;
    if (editor && editor.document && editor.document.languageId) {
        const target = config.createTargetForDocument(ConfigurationTarget.WorkspaceFolder, editor.document);
        return disableLanguage(target, editor.document.languageId);
    }
    return Promise.resolve();
}


export async function enableLocal(target: config.ConfigTarget, local: string) {
    await enableLocalForTarget(local, true, target, true);
}

export async function disableLocal(target: config.ConfigTarget, local: string) {
    await enableLocalForTarget(local, false, target, true);
}

export function enableLocalForTarget(
    local: string,
    enable: boolean,
    target: config.ConfigTarget,
    isCreateAllowed: boolean
): Promise<boolean> {
    const applyFn: (src: string | undefined) => string | undefined = enable
        ? (currentLanguage) => unique(normalizeLocal(currentLanguage).split(',').concat(local.split(','))).join(',')
        : (currentLanguage) => {
            const value = unique(normalizeLocal(currentLanguage).split(',')).filter(lang => lang !== local).join(',');
            return value || undefined;
        };
    return updateSettingInConfig(
        'language',
        target,
        applyFn,
        isCreateAllowed,
        shouldUpdateCSpell(target)
    );
}

export function enableLanguageIdForTarget(
    languageId: string,
    enable: boolean,
    target: config.ConfigTarget,
    isCreateAllowed: boolean
): Promise<boolean> {
    const fn: (src: string[] | undefined) => string[] | undefined = enable
        ? (src) => unique([languageId].concat(src || [])).sort()
        : (src) => {
            const v = src && unique(src.filter(v => v !== languageId)).sort();
            return v && v.length > 0 && v || undefined;
        };
    return updateSettingInConfig(
        'enabledLanguageIds',
        target,
        fn,
        isCreateAllowed,
        shouldUpdateCSpell(target)
    );
}

/**
 * Try to enable / disable a programming language id starting at folder level going to global level, stopping when successful.
 * @param languageId
 * @param enable
 * @param uri
 */
export async function enableLanguageIdForClosestTarget(
    languageId: string,
    enable: boolean,
    uri: Uri | undefined
): Promise<void> {
    if (languageId) {
        if (uri) {
            // Apply it to the workspace folder if it exists.
            const target: config.ConfigTargetWithResource = {
                target: ConfigurationTarget.WorkspaceFolder,
                uri,
            };
            if (await enableLanguageIdForTarget(languageId, enable, target, false)) return;
        }

        if (vscode.workspace.workspaceFolders
            && vscode.workspace.workspaceFolders.length
            && await enableLanguageIdForTarget(languageId, enable, config.Target.Workspace, false)
        ) {
            return;
        }

        // Apply it to User settings.
        await enableLanguageIdForTarget(languageId, enable, config.Target.Global, true);
    }
    return;
}

/**
 * Determine if we should update the cspell file if it exists.
 * 1. Update is allowed for WorkspaceFolders
 * 1. Update is allowed for Workspace if there is only 1 folder.
 * 1. Update is not allowed for the Global target.
 * @param target
 */
function shouldUpdateCSpell(target: config.ConfigTarget) {
    const cfgTarget = config.extractTarget(target);
    return cfgTarget !== config.Target.Global
        && workspace.workspaceFolders
        && (cfgTarget === config.Target.WorkspaceFolder || workspace.workspaceFolders.length === 1);

}

/**
 * Update Config Settings.
 * Writes to both the VS Config and the `cspell.json` if it exists.
 * If a `cspell.json` exists, it will be preferred over the VS Code config setting.
 * @param section the configuration value to set/update.
 * @param target the configuration level (Global, Workspace, WorkspaceFolder)
 * @param applyFn the function to calculate the new value.
 * @param create if the setting does not exist, then create it.
 * @param updateCSpell update the cspell.json file if it exists.
 */
export async function updateSettingInConfig<K extends keyof CSpellUserSettings>(
    section: K,
    target: config.ConfigTarget,
    applyFn: (origValue: CSpellUserSettings[K]) => CSpellUserSettings[K],
    create: boolean,
    updateCSpell: boolean = true
): Promise<boolean> {
    interface Result {
        value: CSpellUserSettings[K] | undefined,
    }

    const scope = config.configTargetToScope(target);
    const orig = config.findScopedSettingFromVSConfig(section, scope);
    const uri = config.isConfigTargetWithOptionalResource(target) && target.uri || undefined;
    const settingsFilename = updateCSpell && !config.isGlobalLevelTarget(target) && await findExistingSettingsFileLocation(uri) || undefined;

    async function updateConfig(): Promise<false | Result> {
        if (create || orig.value !== undefined && orig.scope === config.extractScope(scope)) {
            const newValue = applyFn(orig.value);
            await config.setSettingInVSConfig(section, newValue, target);
            return { value: newValue };
        }
        return false;
    }

    async function updateCSpellFile(settingsFilename: string | undefined, defaultValue: CSpellUserSettings[K] | undefined): Promise<boolean> {
        if (settingsFilename) {
            await CSpellSettings.readApplyUpdateSettingsFile(settingsFilename, settings => {
                const v = settings[section];
                const newValue = v !== undefined ? applyFn(v) : applyFn(defaultValue);
                const newSettings = {...settings };
                if (newValue === undefined) {
                    delete newSettings[section];
                } else {
                    newSettings[section] = newValue;
                }
                return newSettings;
            });
            return true;
        }
        return false;
    }

    const configResult = await updateConfig();
    const cspellResult = await updateCSpellFile(settingsFilename, orig.value);

    return [
        !!configResult,
        cspellResult
    ].reduce((a, b) => a || b, false);
}

performance.mark('settings.ts done');
