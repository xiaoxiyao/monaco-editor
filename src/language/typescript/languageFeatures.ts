/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Diagnostic,
	DiagnosticRelatedInformation,
	LanguageServiceDefaults,
	typescriptDefaults
} from './monaco.contribution';
import type * as ts from './lib/typescriptServices';
import type { TypeScriptWorker } from './tsWorker';
import { libFileSet } from './lib/lib.index';
import {
	editor,
	languages,
	Uri,
	Position,
	Range,
	CancellationToken,
	IDisposable,
	IRange,
	MarkerTag,
	MarkerSeverity,
	IMarkdownString
} from '../../fillers/monaco-editor-core';

//#region utils copied from typescript to prevent loading the entire typescriptServices ---

enum IndentStyle {
	None = 0,
	Block = 1,
	Smart = 2
}

export function flattenDiagnosticMessageText(
	diag: string | ts.DiagnosticMessageChain | undefined,
	newLine: string,
	indent = 0
): string {
	if (typeof diag === 'string') {
		return diag;
	} else if (diag === undefined) {
		return '';
	}
	let result = '';
	if (indent) {
		result += newLine;

		for (let i = 0; i < indent; i++) {
			result += '  ';
		}
	}
	result += diag.messageText;
	indent++;
	if (diag.next) {
		for (const kid of diag.next) {
			result += flattenDiagnosticMessageText(kid, newLine, indent);
		}
	}
	return result;
}

function displayPartsToString(displayParts: ts.SymbolDisplayPart[] | undefined): string {
	if (displayParts) {
		return displayParts.map((displayPart) => displayPart.text).join('');
	}
	return '';
}

function parseKindModifier(kindModifiers: string): Set<string> {
	return new Set(kindModifiers.split(/,|\s+/g));
}

function getScriptKindDetails(tsEntry: ts.CompletionEntry): string | undefined {
	if (!tsEntry.kindModifiers || tsEntry.kind !== ScriptElementKind.scriptElement) {
		return;
	}

	const kindModifiers = parseKindModifier(tsEntry.kindModifiers);
	for (const extModifier of KindModifiers.fileExtensionKindModifiers) {
		if (kindModifiers.has(extModifier)) {
			if (tsEntry.name.toLowerCase().endsWith(extModifier)) {
				return tsEntry.name;
			} else {
				return tsEntry.name + extModifier;
			}
		}
	}
	return undefined;
}

function textSpanToRange(model: editor.ITextModel, span: ts.TextSpan): Range {
	const p1 = model.getPositionAt(span.start);
	const p2 = model.getPositionAt(span.start + span.length);
	return Range.fromPositions(p1, p2);
}

//#endregion

export abstract class Adapter {
	constructor(protected _worker: (...uris: Uri[]) => Promise<TypeScriptWorker>) {}
}

// --- lib files

export class LibFiles {
	private _libFiles: Record<string, string>;
	private _hasFetchedLibFiles: boolean;
	private _fetchLibFilesPromise: Promise<void> | null;

	constructor(private readonly _worker: (...uris: Uri[]) => Promise<TypeScriptWorker>) {
		this._libFiles = {};
		this._hasFetchedLibFiles = false;
		this._fetchLibFilesPromise = null;
	}

	public isLibFile(uri: Uri | null): boolean {
		if (!uri) {
			return false;
		}
		if (uri.path.indexOf('/lib.') === 0) {
			return !!libFileSet[uri.path.slice(1)];
		}
		return false;
	}

	public getOrCreateModel(fileName: string): editor.ITextModel | null {
		const uri = Uri.parse(fileName);
		const model = editor.getModel(uri);
		if (model) {
			return model;
		}
		if (this.isLibFile(uri) && this._hasFetchedLibFiles) {
			return editor.createModel(this._libFiles[uri.path.slice(1)], 'typescript', uri);
		}
		const matchedLibFile = typescriptDefaults.getExtraLibs()[fileName];
		if (matchedLibFile) {
			return editor.createModel(matchedLibFile.content, 'typescript', uri);
		}
		return null;
	}

	private _containsLibFile(uris: (Uri | null)[]): boolean {
		for (let uri of uris) {
			if (this.isLibFile(uri)) {
				return true;
			}
		}
		return false;
	}

	public async fetchLibFilesIfNecessary(uris: (Uri | null)[]): Promise<void> {
		if (!this._containsLibFile(uris)) {
			// no lib files necessary
			return;
		}
		await this._fetchLibFiles();
	}

	private _fetchLibFiles(): Promise<void> {
		if (!this._fetchLibFilesPromise) {
			this._fetchLibFilesPromise = this._worker()
				.then((w) => w.getLibFiles())
				.then((libFiles) => {
					this._hasFetchedLibFiles = true;
					this._libFiles = libFiles;
				});
		}
		return this._fetchLibFilesPromise;
	}
}

// --- diagnostics --- ---

enum DiagnosticCategory {
	Warning = 0,
	Error = 1,
	Suggestion = 2,
	Message = 3
}

/**
 * temporary interface until the editor API exposes
 * `IModel.isAttachedToEditor` and `IModel.onDidChangeAttached`
 */
interface IInternalEditorModel extends editor.IModel {
	onDidChangeAttached(listener: () => void): IDisposable;
	isAttachedToEditor(): boolean;
}

export class DiagnosticsAdapter extends Adapter {
	private _disposables: IDisposable[] = [];
	private _listener: { [uri: string]: IDisposable } = Object.create(null);

	constructor(
		private readonly _libFiles: LibFiles,
		private _defaults: LanguageServiceDefaults,
		private _selector: string,
		worker: (...uris: Uri[]) => Promise<TypeScriptWorker>
	) {
		super(worker);

		const onModelAdd = (model: IInternalEditorModel): void => {
			if (model.getLanguageId() !== _selector) {
				return;
			}

			const maybeValidate = () => {
				const { onlyVisible } = this._defaults.getDiagnosticsOptions();
				if (onlyVisible) {
					if (model.isAttachedToEditor()) {
						this._doValidate(model);
					}
				} else {
					this._doValidate(model);
				}
			};

			let handle: number;
			const changeSubscription = model.onDidChangeContent(() => {
				clearTimeout(handle);
				handle = window.setTimeout(maybeValidate, 500);
			});

			const visibleSubscription = model.onDidChangeAttached(() => {
				const { onlyVisible } = this._defaults.getDiagnosticsOptions();
				if (onlyVisible) {
					if (model.isAttachedToEditor()) {
						// this model is now attached to an editor
						// => compute diagnostics
						maybeValidate();
					} else {
						// this model is no longer attached to an editor
						// => clear existing diagnostics
						editor.setModelMarkers(model, this._selector, []);
					}
				}
			});

			this._listener[model.uri.toString()] = {
				dispose() {
					changeSubscription.dispose();
					visibleSubscription.dispose();
					clearTimeout(handle);
				}
			};

			maybeValidate();
		};

		const onModelRemoved = (model: editor.IModel): void => {
			editor.setModelMarkers(model, this._selector, []);
			const key = model.uri.toString();
			if (this._listener[key]) {
				this._listener[key].dispose();
				delete this._listener[key];
			}
		};

		this._disposables.push(
			editor.onDidCreateModel((model) => onModelAdd(<IInternalEditorModel>model))
		);
		this._disposables.push(editor.onWillDisposeModel(onModelRemoved));
		this._disposables.push(
			editor.onDidChangeModelLanguage((event) => {
				onModelRemoved(event.model);
				onModelAdd(<IInternalEditorModel>event.model);
			})
		);

		this._disposables.push({
			dispose() {
				for (const model of editor.getModels()) {
					onModelRemoved(model);
				}
			}
		});

		const recomputeDiagostics = () => {
			// redo diagnostics when options change
			for (const model of editor.getModels()) {
				onModelRemoved(model);
				onModelAdd(<IInternalEditorModel>model);
			}
		};
		this._disposables.push(this._defaults.onDidChange(recomputeDiagostics));
		this._disposables.push(this._defaults.onDidExtraLibsChange(recomputeDiagostics));

		editor.getModels().forEach((model) => onModelAdd(<IInternalEditorModel>model));
	}

	public dispose(): void {
		this._disposables.forEach((d) => d && d.dispose());
		this._disposables = [];
	}

	private async _doValidate(model: editor.ITextModel): Promise<void> {
		const worker = await this._worker(model.uri);

		if (model.isDisposed()) {
			// model was disposed in the meantime
			return;
		}

		const promises: Promise<Diagnostic[]>[] = [];
		const { noSyntaxValidation, noSemanticValidation, noSuggestionDiagnostics } =
			this._defaults.getDiagnosticsOptions();
		if (!noSyntaxValidation) {
			promises.push(worker.getSyntacticDiagnostics(model.uri.toString()));
		}
		if (!noSemanticValidation) {
			promises.push(worker.getSemanticDiagnostics(model.uri.toString()));
		}
		if (!noSuggestionDiagnostics) {
			promises.push(worker.getSuggestionDiagnostics(model.uri.toString()));
		}

		const allDiagnostics = await Promise.all(promises);

		if (!allDiagnostics || model.isDisposed()) {
			// model was disposed in the meantime
			return;
		}

		const diagnostics = allDiagnostics
			.reduce((p, c) => c.concat(p), [])
			.filter(
				(d) =>
					(this._defaults.getDiagnosticsOptions().diagnosticCodesToIgnore || []).indexOf(d.code) ===
					-1
			);

		// Fetch lib files if necessary
		const relatedUris = diagnostics
			.map((d) => d.relatedInformation || [])
			.reduce((p, c) => c.concat(p), [])
			.map((relatedInformation) =>
				relatedInformation.file ? Uri.parse(relatedInformation.file.fileName) : null
			);

		await this._libFiles.fetchLibFilesIfNecessary(relatedUris);

		if (model.isDisposed()) {
			// model was disposed in the meantime
			return;
		}

		editor.setModelMarkers(
			model,
			this._selector,
			diagnostics.map((d) => this._convertDiagnostics(model, d))
		);
	}

	private _convertDiagnostics(model: editor.ITextModel, diag: Diagnostic): editor.IMarkerData {
		const diagStart = diag.start || 0;
		const diagLength = diag.length || 1;
		const { lineNumber: startLineNumber, column: startColumn } = model.getPositionAt(diagStart);
		const { lineNumber: endLineNumber, column: endColumn } = model.getPositionAt(
			diagStart + diagLength
		);

		const tags: MarkerTag[] = [];
		if (diag.reportsUnnecessary) {
			tags.push(MarkerTag.Unnecessary);
		}
		if (diag.reportsDeprecated) {
			tags.push(MarkerTag.Deprecated);
		}

		return {
			severity: this._tsDiagnosticCategoryToMarkerSeverity(diag.category),
			startLineNumber,
			startColumn,
			endLineNumber,
			endColumn,
			message: flattenDiagnosticMessageText(diag.messageText, '\n'),
			code: diag.code.toString(),
			tags,
			relatedInformation: this._convertRelatedInformation(model, diag.relatedInformation)
		};
	}

	private _convertRelatedInformation(
		model: editor.ITextModel,
		relatedInformation?: DiagnosticRelatedInformation[]
	): editor.IRelatedInformation[] {
		if (!relatedInformation) {
			return [];
		}

		const result: editor.IRelatedInformation[] = [];
		relatedInformation.forEach((info) => {
			let relatedResource: editor.ITextModel | null = model;
			if (info.file) {
				relatedResource = this._libFiles.getOrCreateModel(info.file.fileName);
			}

			if (!relatedResource) {
				return;
			}
			const infoStart = info.start || 0;
			const infoLength = info.length || 1;
			const { lineNumber: startLineNumber, column: startColumn } =
				relatedResource.getPositionAt(infoStart);
			const { lineNumber: endLineNumber, column: endColumn } = relatedResource.getPositionAt(
				infoStart + infoLength
			);

			result.push({
				resource: relatedResource.uri,
				startLineNumber,
				startColumn,
				endLineNumber,
				endColumn,
				message: flattenDiagnosticMessageText(info.messageText, '\n')
			});
		});
		return result;
	}

	private _tsDiagnosticCategoryToMarkerSeverity(category: ts.DiagnosticCategory): MarkerSeverity {
		switch (category) {
			case DiagnosticCategory.Error:
				return MarkerSeverity.Error;
			case DiagnosticCategory.Message:
				return MarkerSeverity.Info;
			case DiagnosticCategory.Warning:
				return MarkerSeverity.Warning;
			case DiagnosticCategory.Suggestion:
				return MarkerSeverity.Hint;
		}
		return MarkerSeverity.Info;
	}
}

// --- suggest ------

interface DotAccessorContext {
	readonly range: Range;
	readonly text: string;
}

interface CompletionContext {
	readonly isNewIdentifierLocation: boolean;
	readonly isMemberCompletion: boolean;

	readonly dotAccessorContext?: DotAccessorContext;

	readonly enableCallCompletions: boolean;
	readonly completeFunctionCalls: boolean;

	readonly wordRange: Range;
	readonly line: string;
	readonly optionalReplacementRange: Range | undefined;
}

class MyCompletionItem implements languages.CompletionItem {
	label: string | languages.CompletionItemLabel;
	kind: languages.CompletionItemKind;
	tags?: readonly languages.CompletionItemTag[] | undefined;
	detail?: string | undefined;
	sortText?: string | undefined;
	filterText?: string | undefined;
	preselect?: boolean | undefined;
	documentation?: string | IMarkdownString;
	insertText: string;
	insertTextRules?: languages.CompletionItemInsertTextRule | undefined;
	range: IRange | languages.CompletionItemRanges;
	commitCharacters?: string[] | undefined;
	additionalTextEdits?: editor.ISingleEditOperation[] | undefined;
	command?: languages.Command | undefined;
	uri: Uri;
	offset: number;
	constructor(
		private readonly model: editor.ITextModel,
		public readonly position: Position,
		public readonly tsEntry: ts.CompletionEntry,
		private readonly completionContext: CompletionContext,
		public readonly metadata: any | undefined
	) {
		this.uri = model.uri;
		this.offset = model.getOffsetAt(position);
		const label = tsEntry.name || (tsEntry.insertText ?? '');
		this.label = label;
		this.kind = MyCompletionItem.convertKind(tsEntry.kind);
		if (tsEntry.source && tsEntry.hasAction) {
			// De-prioritze auto-imports
			// https://github.com/microsoft/vscode/issues/40311
			this.sortText = '\uffff' + tsEntry.sortText;
		} else {
			this.sortText = tsEntry.sortText;
		}

		const sourceDisplay = tsEntry.sourceDisplay;
		if (sourceDisplay) {
			this.label = { label, description: displayPartsToString(sourceDisplay) };
		}
		if (tsEntry.labelDetails) {
			this.label = { label, ...tsEntry.labelDetails };
		}
		this.preselect = tsEntry.isRecommended;
		this.position = position;

		let range = this.getRangeFromReplacementSpan(tsEntry, completionContext);

		this.commitCharacters = MyCompletionItem.getCommitCharacters(completionContext, tsEntry);
		this.insertText = tsEntry.insertText ?? tsEntry.name;
		this.filterText = this.getFilterText(completionContext.line, tsEntry.insertText);
		const wordRange = this.completionContext.wordRange;
		if (completionContext.isMemberCompletion && completionContext.dotAccessorContext) {
			this.filterText =
				completionContext.dotAccessorContext.text + (this.insertText || this.textLabel);
			if (!range) {
				range = {
					insert: completionContext.dotAccessorContext.range,
					replace: completionContext.dotAccessorContext.range.plusRange(wordRange)
				};
				this.insertText = this.filterText;
			}
		}
		this.range = range ?? wordRange;
		if (tsEntry.kindModifiers) {
			const kindModifiers = parseKindModifier(tsEntry.kindModifiers);
			if (kindModifiers.has(KindModifiers.optional)) {
				this.insertText ??= this.textLabel;
				this.filterText ??= this.textLabel;

				if (typeof this.label === 'string') {
					this.label += '?';
				} else {
					this.label.label += '?';
				}
			}
			if (kindModifiers.has(KindModifiers.deprecated)) {
				this.tags = [languages.CompletionItemTag.Deprecated];
			}

			if (kindModifiers.has(KindModifiers.color)) {
				this.kind = languages.CompletionItemKind.Color;
			}

			this.detail = getScriptKindDetails(tsEntry);
		}
		if (tsEntry.isSnippet) {
			this.insertTextRules = languages.CompletionItemInsertTextRule.InsertAsSnippet;
		}
	}

	private get textLabel() {
		return typeof this.label === 'string' ? this.label : this.label.label;
	}

	private getRangeFromReplacementSpan(
		tsEntry: ts.CompletionEntry,
		completionContext: CompletionContext
	): languages.CompletionItemRanges | undefined {
		let model = this.model;
		if (!tsEntry.replacementSpan) {
			if (completionContext.optionalReplacementRange) {
				return {
					insert: Range.fromPositions(
						completionContext.optionalReplacementRange.getStartPosition(),
						this.position
					),
					replace: completionContext.optionalReplacementRange
				};
			}

			return undefined;
		}

		// If TS returns an explicit replacement range on this item, we should use it for both types of completion

		// Make sure we only replace a single line at most
		if (tsEntry.replacementSpan) {
			let replaceRange = textSpanToRange(model, tsEntry.replacementSpan);
			if (Range.spansMultipleLines(replaceRange)) {
				replaceRange = new Range(
					replaceRange.startLineNumber,
					replaceRange.startColumn,
					replaceRange.startLineNumber,
					completionContext.line.length
				);
			}
			return {
				insert: replaceRange,
				replace: replaceRange
			};
		}
	}

	private getFilterText(line: string, insertText: string | undefined): string | undefined {
		// Handle private field completions
		if (this.tsEntry.name.startsWith('#')) {
			const wordRange = this.completionContext.wordRange;
			const wordStart = wordRange ? line.charAt(wordRange.startColumn) : undefined;
			if (insertText) {
				if (insertText.startsWith('this.#')) {
					return wordStart === '#' ? insertText : insertText.replace(/^this\.#/, '');
				} else {
					return insertText;
				}
			} else {
				return wordStart === '#' ? undefined : this.tsEntry.name.replace(/^#/, '');
			}
		}

		// For `this.` completions, generally don't set the filter text since we don't want them to be overly prioritized. #74164
		if (insertText?.startsWith('this.')) {
			return undefined;
		}

		// Handle the case:
		// ```
		// const xyz = { 'ab c': 1 };
		// xyz.ab|
		// ```
		// In which case we want to insert a bracket accessor but should use `.abc` as the filter text instead of
		// the bracketed insert text.
		else if (insertText?.startsWith('[')) {
			return insertText.replace(/^\[['"](.+)[['"]\]$/, '.$1');
		}

		// In all other cases, fallback to using the insertText
		return insertText;
	}

	public resolveCompletionItem(details: ts.CompletionEntryDetails): void {
		const newItemDetails = this.getDetails(details);
		if (newItemDetails) {
			this.detail = newItemDetails;
		}
		this.documentation = this.getDocumentation(details);
		this.command = this.getCommand(details);
	}

	private getDetails(detail: ts.CompletionEntryDetails): string | undefined {
		const parts: string[] = [];

		if (detail.kind === ScriptElementKind.scriptElement) {
			// details were already added
			return undefined;
		}

		for (const action of detail.codeActions ?? []) {
			parts.push(action.description);
		}

		parts.push(displayPartsToString(detail.displayParts));
		return parts.join('\n\n');
	}

	private getDocumentation(details: ts.CompletionEntryDetails): IMarkdownString | undefined {
		let documentationString = displayPartsToString(details.documentation);
		if (details.tags) {
			for (const tag of details.tags) {
				documentationString += `\n\n${tagToString(tag)}`;
			}
		}
		if (!documentationString.length) {
			return undefined;
		}
		return {
			value: documentationString,
			baseUri: this.uri
		};
	}

	private getCommand(detail: ts.CompletionEntryDetails): languages.Command | undefined {
		if (!detail.codeActions?.length) {
			return undefined;
		}

		return {
			id: ApplyCompletionCommand.ID,
			title: '',
			arguments: [this.uri, detail.codeActions]
		};
	}

	private static convertKind(kind: ScriptElementKind): languages.CompletionItemKind {
		switch (kind) {
			case ScriptElementKind.primitiveType:
			case ScriptElementKind.keyword:
				return languages.CompletionItemKind.Keyword;
			case ScriptElementKind.variableElement:
			case ScriptElementKind.localVariableElement:
				return languages.CompletionItemKind.Variable;
			case ScriptElementKind.memberVariableElement:
			case ScriptElementKind.memberGetAccessorElement:
			case ScriptElementKind.memberSetAccessorElement:
				return languages.CompletionItemKind.Field;
			case ScriptElementKind.functionElement:
			case ScriptElementKind.memberFunctionElement:
			case ScriptElementKind.constructSignatureElement:
			case ScriptElementKind.callSignatureElement:
			case ScriptElementKind.indexSignatureElement:
				return languages.CompletionItemKind.Function;
			case ScriptElementKind.enumElement:
				return languages.CompletionItemKind.Enum;
			case ScriptElementKind.moduleElement:
				return languages.CompletionItemKind.Module;
			case ScriptElementKind.classElement:
				return languages.CompletionItemKind.Class;
			case ScriptElementKind.interfaceElement:
				return languages.CompletionItemKind.Interface;
			case ScriptElementKind.warning:
				return languages.CompletionItemKind.File;
		}

		return languages.CompletionItemKind.Property;
	}

	private static getCommitCharacters(
		context: CompletionContext,
		entry: ts.CompletionEntry
	): string[] | undefined {
		if (entry.kind === ScriptElementKind.warning || entry.kind === ScriptElementKind.string) {
			// Ambient JS word based suggestion, strings
			return undefined;
		}

		if (context.isNewIdentifierLocation) {
			return undefined;
		}

		const commitCharacters: string[] = ['.', ',', ';'];
		if (context.enableCallCompletions) {
			commitCharacters.push('(');
		}

		return commitCharacters;
	}
}

class ApplyCompletionCommand implements editor.ICommandDescriptor {
	public static readonly ID = '_typescript.applyCompletionCommand';
	public readonly id = ApplyCompletionCommand.ID;

	public async run(accessor: any, resource: Uri, codeActions: ts.CodeAction[]): Promise<void> {
		if (codeActions.length === 0) {
			return;
		}
		let model = editor.getModel(resource);
		if (model == null) {
			return;
		}
		for (const action of codeActions) {
			if (action.commands) {
				console.log(action.commands); // TODO 如何运行action中的command？
			}
			action.changes?.forEach((change) => {
				// 暂时只处理当前文件的更改
				if (change.fileName === resource.toString()) {
					model!.pushEditOperations(
						null,
						change.textChanges?.map((textChange) => {
							return {
								range: textSpanToRange(model!, textChange.span),
								text: textChange.newText
							};
						}),
						() => null
					);
				}
			});
		}
	}
}

editor.addCommand(new ApplyCompletionCommand());

export class SuggestAdapter extends Adapter implements languages.CompletionItemProvider {
	public get triggerCharacters(): string[] {
		return ['.', '"', "'", '`', '/', '@', '<', '#', ' '];
	}

	public async provideCompletionItems(
		model: editor.ITextModel,
		position: Position,
		_context: languages.CompletionContext,
		token: CancellationToken
	): Promise<languages.CompletionList | undefined> {
		const resource = model.uri;
		const worker = await this._worker(resource);
		if (token.isCancellationRequested || model.isDisposed()) {
			return;
		}
		const offset = model.getOffsetAt(position);
		const info = await worker.getCompletionsAtPosition(resource.toString(), offset, {
			...typescriptDefaults.getUserPreferences(),
			triggerCharacter: _context.triggerCharacter as ts.CompletionsTriggerCharacter,
			triggerKind: SuggestAdapter.convertTriggerKind(_context.triggerKind)
		});

		if (!info || model.isDisposed() || token.isCancellationRequested) {
			return;
		}
		const wordInfo = model.getWordUntilPosition(position);
		const wordRange = new Range(
			position.lineNumber,
			wordInfo.startColumn,
			position.lineNumber,
			wordInfo.endColumn
		);

		const line = model.getLineContent(position.lineNumber);
		let dotAccessorContext;
		const isMemberCompletion = info.isMemberCompletion;
		if (isMemberCompletion) {
			const dotMatch = line.slice(0, position.column).match(/\??\.\s*$/) || undefined;
			if (dotMatch) {
				const range = Range.fromPositions(position.delta(0, -dotMatch[0].length), position);
				const text = model.getValueInRange(range);
				dotAccessorContext = { range, text };
			}
		}
		const completionContext: CompletionContext = {
			isNewIdentifierLocation: info.isNewIdentifierLocation,
			isMemberCompletion,
			dotAccessorContext,
			enableCallCompletions: true,
			wordRange,
			line,
			completeFunctionCalls: true,
			optionalReplacementRange:
				info.optionalReplacementSpan && textSpanToRange(model, info.optionalReplacementSpan)
		};

		const suggestions: MyCompletionItem[] = info.entries.map((entry) => {
			return new MyCompletionItem(model, position, entry, completionContext, info.metadata);
		});

		return {
			suggestions
		};
	}

	public async resolveCompletionItem(
		item: languages.CompletionItem,
		token: CancellationToken
	): Promise<languages.CompletionItem> {
		const myItem = <MyCompletionItem>item;
		const resource = myItem.uri;
		const offset = myItem.offset;

		const worker = await this._worker(resource);
		if (token.isCancellationRequested) {
			return myItem;
		}
		const entry = myItem.tsEntry;
		const details = await worker.getCompletionEntryDetails(
			resource.toString(),
			offset,
			entry.name,
			{},
			entry.source,
			typescriptDefaults.getUserPreferences(),
			entry.data
		);
		if (token.isCancellationRequested || !details) {
			return myItem;
		}
		myItem.resolveCompletionItem(details);
		return myItem;
	}

	private static convertTriggerKind(
		kind: languages.CompletionTriggerKind
	): ts.CompletionTriggerKind {
		switch (kind) {
			case languages.CompletionTriggerKind.Invoke:
				return 1;
			case languages.CompletionTriggerKind.TriggerCharacter:
				return 2;
			case languages.CompletionTriggerKind.TriggerForIncompleteCompletions:
				return 3;
		}
	}
}

function tagToString(tag: ts.JSDocTagInfo): string {
	let tagLabel = `*@${tag.name}*`;
	if (tag.name === 'param' && tag.text) {
		const [paramName, ...rest] = tag.text;
		tagLabel += `\`${paramName.text}\``;
		if (rest.length > 0) tagLabel += ` — ${rest.map((r) => r.text).join(' ')}`;
	} else if (Array.isArray(tag.text)) {
		tagLabel += ` — ${tag.text.map((r) => r.text).join(' ')}`;
	} else if (tag.text) {
		tagLabel += ` — ${tag.text}`;
	}
	return tagLabel;
}

export class SignatureHelpAdapter extends Adapter implements languages.SignatureHelpProvider {
	public signatureHelpTriggerCharacters = ['(', ','];

	private static _toSignatureHelpTriggerReason(
		context: languages.SignatureHelpContext
	): ts.SignatureHelpTriggerReason {
		switch (context.triggerKind) {
			case languages.SignatureHelpTriggerKind.TriggerCharacter:
				if (context.triggerCharacter) {
					if (context.isRetrigger) {
						return { kind: 'retrigger', triggerCharacter: context.triggerCharacter as any };
					} else {
						return { kind: 'characterTyped', triggerCharacter: context.triggerCharacter as any };
					}
				} else {
					return { kind: 'invoked' };
				}

			case languages.SignatureHelpTriggerKind.ContentChange:
				return context.isRetrigger ? { kind: 'retrigger' } : { kind: 'invoked' };

			case languages.SignatureHelpTriggerKind.Invoke:
			default:
				return { kind: 'invoked' };
		}
	}

	public async provideSignatureHelp(
		model: editor.ITextModel,
		position: Position,
		token: CancellationToken,
		context: languages.SignatureHelpContext
	): Promise<languages.SignatureHelpResult | undefined> {
		const resource = model.uri;
		const offset = model.getOffsetAt(position);
		const worker = await this._worker(resource);

		if (model.isDisposed()) {
			return;
		}

		const info = await worker.getSignatureHelpItems(resource.toString(), offset, {
			triggerReason: SignatureHelpAdapter._toSignatureHelpTriggerReason(context)
		});

		if (!info || model.isDisposed()) {
			return;
		}

		const ret: languages.SignatureHelp = {
			activeSignature: info.selectedItemIndex,
			activeParameter: info.argumentIndex,
			signatures: []
		};

		info.items.forEach((item) => {
			const signature: languages.SignatureInformation = {
				label: '',
				parameters: []
			};

			signature.documentation = {
				value: displayPartsToString(item.documentation)
			};
			signature.label += displayPartsToString(item.prefixDisplayParts);
			item.parameters.forEach((p, i, a) => {
				const label = displayPartsToString(p.displayParts);
				const parameter: languages.ParameterInformation = {
					label: label,
					documentation: {
						value: displayPartsToString(p.documentation)
					}
				};
				signature.label += label;
				signature.parameters.push(parameter);
				if (i < a.length - 1) {
					signature.label += displayPartsToString(item.separatorDisplayParts);
				}
			});
			signature.label += displayPartsToString(item.suffixDisplayParts);
			ret.signatures.push(signature);
		});

		return {
			value: ret,
			dispose() {}
		};
	}
}

// --- hover ------

export class QuickInfoAdapter extends Adapter implements languages.HoverProvider {
	public async provideHover(
		model: editor.ITextModel,
		position: Position,
		token: CancellationToken
	): Promise<languages.Hover | undefined> {
		const resource = model.uri;
		const offset = model.getOffsetAt(position);
		const worker = await this._worker(resource);

		if (model.isDisposed()) {
			return;
		}

		const info = await worker.getQuickInfoAtPosition(resource.toString(), offset);

		if (!info || model.isDisposed()) {
			return;
		}

		const documentation = displayPartsToString(info.documentation);
		const tags = info.tags ? info.tags.map((tag) => tagToString(tag)).join('  \n\n') : '';
		const contents = displayPartsToString(info.displayParts);
		return {
			range: textSpanToRange(model, info.textSpan),
			contents: [
				{
					value: '```typescript\n' + contents + '\n```\n'
				},
				{
					value: documentation + (tags ? '\n\n' + tags : '')
				}
			]
		};
	}
}

// --- occurrences ------

export class DocumentHighlightAdapter
	extends Adapter
	implements languages.DocumentHighlightProvider
{
	public async provideDocumentHighlights(
		model: editor.ITextModel,
		position: Position,
		token: CancellationToken
	): Promise<languages.DocumentHighlight[] | undefined> {
		const resource = model.uri;
		const offset = model.getOffsetAt(position);
		const worker = await this._worker(resource);

		if (model.isDisposed()) {
			return;
		}

		const entries = await worker.getDocumentHighlights(resource.toString(), offset, [
			resource.toString()
		]);

		if (!entries || model.isDisposed()) {
			return;
		}

		return entries.flatMap((entry) => {
			return entry.highlightSpans.map((highlightSpans) => {
				return <languages.DocumentHighlight>{
					range: textSpanToRange(model, highlightSpans.textSpan),
					kind:
						highlightSpans.kind === 'writtenReference'
							? languages.DocumentHighlightKind.Write
							: languages.DocumentHighlightKind.Text
				};
			});
		});
	}
}

// --- definition ------

export class DefinitionAdapter extends Adapter {
	constructor(
		private readonly _libFiles: LibFiles,
		worker: (...uris: Uri[]) => Promise<TypeScriptWorker>
	) {
		super(worker);
	}

	public async provideDefinition(
		model: editor.ITextModel,
		position: Position,
		token: CancellationToken
	): Promise<languages.Definition | undefined> {
		const resource = model.uri;
		const offset = model.getOffsetAt(position);
		const worker = await this._worker(resource);

		if (model.isDisposed()) {
			return;
		}

		const entries = await worker.getDefinitionAtPosition(resource.toString(), offset);

		if (!entries || model.isDisposed()) {
			return;
		}

		// Fetch lib files if necessary
		await this._libFiles.fetchLibFilesIfNecessary(
			entries.map((entry) => Uri.parse(entry.fileName))
		);

		if (model.isDisposed()) {
			return;
		}

		const result: languages.Location[] = [];
		for (let entry of entries) {
			const refModel = this._libFiles.getOrCreateModel(entry.fileName);
			if (refModel) {
				result.push({
					uri: refModel.uri,
					range: textSpanToRange(refModel, entry.textSpan)
				});
			}
		}
		return result;
	}
}

// --- references ------

export class ReferenceAdapter extends Adapter implements languages.ReferenceProvider {
	constructor(
		private readonly _libFiles: LibFiles,
		worker: (...uris: Uri[]) => Promise<TypeScriptWorker>
	) {
		super(worker);
	}

	public async provideReferences(
		model: editor.ITextModel,
		position: Position,
		context: languages.ReferenceContext,
		token: CancellationToken
	): Promise<languages.Location[] | undefined> {
		const resource = model.uri;
		const offset = model.getOffsetAt(position);
		const worker = await this._worker(resource);

		if (model.isDisposed()) {
			return;
		}

		const entries = await worker.getReferencesAtPosition(resource.toString(), offset);

		if (!entries || model.isDisposed()) {
			return;
		}

		// Fetch lib files if necessary
		await this._libFiles.fetchLibFilesIfNecessary(
			entries.map((entry) => Uri.parse(entry.fileName))
		);

		if (model.isDisposed()) {
			return;
		}

		const result: languages.Location[] = [];
		for (let entry of entries) {
			const refModel = this._libFiles.getOrCreateModel(entry.fileName);
			if (refModel) {
				result.push({
					uri: refModel.uri,
					range: textSpanToRange(refModel, entry.textSpan)
				});
			}
		}
		return result;
	}
}

// --- outline ------

export class OutlineAdapter extends Adapter implements languages.DocumentSymbolProvider {
	public async provideDocumentSymbols(
		model: editor.ITextModel,
		token: CancellationToken
	): Promise<languages.DocumentSymbol[] | undefined> {
		const resource = model.uri;
		const worker = await this._worker(resource);

		if (model.isDisposed()) {
			return;
		}

		const root = await worker.getNavigationTree(resource.toString());

		if (!root || model.isDisposed()) {
			return;
		}

		const convert = (
			item: ts.NavigationTree,
			containerLabel?: string
		): languages.DocumentSymbol => {
			const result: languages.DocumentSymbol = {
				name: item.text,
				detail: '',
				kind: <languages.SymbolKind>(outlineTypeTable[item.kind] || languages.SymbolKind.Variable),
				range: textSpanToRange(model, item.spans[0]),
				selectionRange: textSpanToRange(model, item.spans[0]),
				tags: [],
				children: item.childItems?.map((child) => convert(child, item.text)),
				containerName: containerLabel
			};
			return result;
		};

		// Exclude the root node, as it alwas spans the entire document.
		const result = root.childItems ? root.childItems.map((item) => convert(item)) : [];
		return result;
	}
}

enum ScriptElementKind {
	unknown = '',
	warning = 'warning',
	/** predefined type (void) or keyword (class) */
	keyword = 'keyword',
	/** top level script node */
	scriptElement = 'script',
	/** module foo {} */
	moduleElement = 'module',
	/** class X {} */
	classElement = 'class',
	/** var x = class X {} */
	localClassElement = 'local class',
	/** interface Y {} */
	interfaceElement = 'interface',
	/** type T = ... */
	typeElement = 'type',
	/** enum E */
	enumElement = 'enum',
	enumMemberElement = 'enum member',
	/**
	 * Inside module and script only
	 * const v = ..
	 */
	variableElement = 'var',
	/** Inside function */
	localVariableElement = 'local var',
	/** using foo = ... */
	variableUsingElement = 'using',
	/** await using foo = ... */
	variableAwaitUsingElement = 'await using',
	/**
	 * Inside module and script only
	 * function f() { }
	 */
	functionElement = 'function',
	/** Inside function */
	localFunctionElement = 'local function',
	/** class X { [public|private]* foo() {} } */
	memberFunctionElement = 'method',
	/** class X { [public|private]* [get|set] foo:number; } */
	memberGetAccessorElement = 'getter',
	memberSetAccessorElement = 'setter',
	/**
	 * class X { [public|private]* foo:number; }
	 * interface Y { foo:number; }
	 */
	memberVariableElement = 'property',
	/** class X { [public|private]* accessor foo: number; } */
	memberAccessorVariableElement = 'accessor',
	/**
	 * class X { constructor() { } }
	 * class X { static { } }
	 */
	constructorImplementationElement = 'constructor',
	/** interface Y { ():number; } */
	callSignatureElement = 'call',
	/** interface Y { []:number; } */
	indexSignatureElement = 'index',
	/** interface Y { new():Y; } */
	constructSignatureElement = 'construct',
	/** function foo(*Y*: string) */
	parameterElement = 'parameter',
	typeParameterElement = 'type parameter',
	primitiveType = 'primitive type',
	label = 'label',
	alias = 'alias',
	constElement = 'const',
	letElement = 'let',
	directory = 'directory',
	externalModuleName = 'external module name',
	/**
	 * <JsxTagName attribute1 attribute2={0} />
	 * @deprecated
	 */
	jsxAttribute = 'JSX attribute',
	/** String literal */
	string = 'string',
	/** Jsdoc @link: in `{@link C link text}`, the before and after text "{@link " and "}" */
	link = 'link',
	/** Jsdoc @link: in `{@link C link text}`, the entity name "C" */
	linkName = 'link name',
	/** Jsdoc @link: in `{@link C link text}`, the link text "link text" */
	linkText = 'link text'
}

class KindModifiers {
	public static readonly optional = 'optional';
	public static readonly deprecated = 'deprecated';
	public static readonly color = 'color';

	public static readonly dtsFile = '.d.ts';
	public static readonly tsFile = '.ts';
	public static readonly tsxFile = '.tsx';
	public static readonly jsFile = '.js';
	public static readonly jsxFile = '.jsx';
	public static readonly jsonFile = '.json';

	public static readonly fileExtensionKindModifiers = [
		KindModifiers.dtsFile,
		KindModifiers.tsFile,
		KindModifiers.tsxFile,
		KindModifiers.jsFile,
		KindModifiers.jsxFile,
		KindModifiers.jsonFile
	];
}

let outlineTypeTable: {
	[kind: string]: languages.SymbolKind;
} = Object.create(null);
outlineTypeTable[ScriptElementKind.moduleElement] = languages.SymbolKind.Module;
outlineTypeTable[ScriptElementKind.classElement] = languages.SymbolKind.Class;
outlineTypeTable[ScriptElementKind.enumElement] = languages.SymbolKind.Enum;
outlineTypeTable[ScriptElementKind.interfaceElement] = languages.SymbolKind.Interface;
outlineTypeTable[ScriptElementKind.memberFunctionElement] = languages.SymbolKind.Method;
outlineTypeTable[ScriptElementKind.memberVariableElement] = languages.SymbolKind.Property;
outlineTypeTable[ScriptElementKind.memberGetAccessorElement] = languages.SymbolKind.Property;
outlineTypeTable[ScriptElementKind.memberSetAccessorElement] = languages.SymbolKind.Property;
outlineTypeTable[ScriptElementKind.variableElement] = languages.SymbolKind.Variable;
outlineTypeTable[ScriptElementKind.constElement] = languages.SymbolKind.Variable;
outlineTypeTable[ScriptElementKind.localVariableElement] = languages.SymbolKind.Variable;
outlineTypeTable[ScriptElementKind.variableElement] = languages.SymbolKind.Variable;
outlineTypeTable[ScriptElementKind.functionElement] = languages.SymbolKind.Function;
outlineTypeTable[ScriptElementKind.localFunctionElement] = languages.SymbolKind.Function;

// --- formatting ----

export abstract class FormatHelper extends Adapter {
	protected static _convertOptions(options: languages.FormattingOptions): ts.FormatCodeOptions {
		return {
			ConvertTabsToSpaces: options.insertSpaces,
			TabSize: options.tabSize,
			IndentSize: options.tabSize,
			IndentStyle: IndentStyle.Smart,
			NewLineCharacter: '\n',
			InsertSpaceAfterCommaDelimiter: true,
			InsertSpaceAfterSemicolonInForStatements: true,
			InsertSpaceBeforeAndAfterBinaryOperators: true,
			InsertSpaceAfterKeywordsInControlFlowStatements: true,
			InsertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
			InsertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
			InsertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: false,
			InsertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: false,
			PlaceOpenBraceOnNewLineForControlBlocks: false,
			PlaceOpenBraceOnNewLineForFunctions: false
		};
	}

	protected _convertTextChanges(
		model: editor.ITextModel,
		change: ts.TextChange
	): languages.TextEdit {
		return {
			text: change.newText,
			range: textSpanToRange(model, change.span)
		};
	}
}

export class FormatAdapter
	extends FormatHelper
	implements languages.DocumentRangeFormattingEditProvider
{
	readonly canFormatMultipleRanges = false;

	public async provideDocumentRangeFormattingEdits(
		model: editor.ITextModel,
		range: Range,
		options: languages.FormattingOptions,
		token: CancellationToken
	): Promise<languages.TextEdit[] | undefined> {
		const resource = model.uri;
		const startOffset = model.getOffsetAt({
			lineNumber: range.startLineNumber,
			column: range.startColumn
		});
		const endOffset = model.getOffsetAt({
			lineNumber: range.endLineNumber,
			column: range.endColumn
		});
		const worker = await this._worker(resource);

		if (model.isDisposed()) {
			return;
		}

		const edits = await worker.getFormattingEditsForRange(
			resource.toString(),
			startOffset,
			endOffset,
			FormatHelper._convertOptions(options)
		);

		if (!edits || model.isDisposed()) {
			return;
		}

		return edits.map((edit) => this._convertTextChanges(model, edit));
	}
}

export class FormatOnTypeAdapter
	extends FormatHelper
	implements languages.OnTypeFormattingEditProvider
{
	get autoFormatTriggerCharacters() {
		return [';', '}', '\n'];
	}

	public async provideOnTypeFormattingEdits(
		model: editor.ITextModel,
		position: Position,
		ch: string,
		options: languages.FormattingOptions,
		token: CancellationToken
	): Promise<languages.TextEdit[] | undefined> {
		const resource = model.uri;
		const offset = model.getOffsetAt(position);
		const worker = await this._worker(resource);

		if (model.isDisposed()) {
			return;
		}

		const edits = await worker.getFormattingEditsAfterKeystroke(
			resource.toString(),
			offset,
			ch,
			FormatHelper._convertOptions(options)
		);

		if (!edits || model.isDisposed()) {
			return;
		}

		return edits.map((edit) => this._convertTextChanges(model, edit));
	}
}

// --- code actions ------

export class CodeActionAdaptor extends FormatHelper implements languages.CodeActionProvider {
	public async provideCodeActions(
		model: editor.ITextModel,
		range: Range,
		context: languages.CodeActionContext,
		token: CancellationToken
	): Promise<languages.CodeActionList | undefined> {
		const resource = model.uri;
		const start = model.getOffsetAt({
			lineNumber: range.startLineNumber,
			column: range.startColumn
		});
		const end = model.getOffsetAt({
			lineNumber: range.endLineNumber,
			column: range.endColumn
		});
		const formatOptions = FormatHelper._convertOptions(model.getOptions());
		const errorCodes = context.markers
			.filter((m) => m.code)
			.map((m) => m.code)
			.map(Number);
		const worker = await this._worker(resource);

		if (model.isDisposed()) {
			return;
		}

		const codeFixes = await worker.getCodeFixesAtPosition(
			resource.toString(),
			start,
			end,
			errorCodes,
			formatOptions,
			typescriptDefaults.getUserPreferences()
		);

		if (!codeFixes || model.isDisposed()) {
			return { actions: [], dispose: () => {} };
		}

		const actions = codeFixes
			.filter((fix) => {
				// Removes any 'make a new file'-type code fix
				return fix.changes.filter((change) => change.isNewFile).length === 0;
			})
			.map((fix) => {
				return this._tsCodeFixActionToMonacoCodeAction(model, context, fix);
			});

		return {
			actions: actions,
			dispose: () => {}
		};
	}

	private _tsCodeFixActionToMonacoCodeAction(
		model: editor.ITextModel,
		context: languages.CodeActionContext,
		codeFix: ts.CodeFixAction
	): languages.CodeAction {
		const edits: languages.IWorkspaceTextEdit[] = [];
		for (const change of codeFix.changes) {
			for (const textChange of change.textChanges) {
				edits.push({
					resource: model.uri,
					versionId: undefined,
					textEdit: {
						range: textSpanToRange(model, textChange.span),
						text: textChange.newText
					}
				});
			}
		}

		const action: languages.CodeAction = {
			title: codeFix.description,
			edit: { edits: edits },
			diagnostics: context.markers,
			kind: 'quickfix'
		};

		return action;
	}
}
// --- rename ----

export class RenameAdapter extends Adapter implements languages.RenameProvider {
	constructor(
		private readonly _libFiles: LibFiles,
		worker: (...uris: Uri[]) => Promise<TypeScriptWorker>
	) {
		super(worker);
	}
	public async provideRenameEdits(
		model: editor.ITextModel,
		position: Position,
		newName: string,
		token: CancellationToken
	): Promise<(languages.WorkspaceEdit & languages.Rejection) | undefined> {
		const resource = model.uri;
		const fileName = resource.toString();
		const offset = model.getOffsetAt(position);
		const worker = await this._worker(resource);

		if (model.isDisposed()) {
			return;
		}

		const preferences = typescriptDefaults.getUserPreferences();
		const renameInfo = await worker.getRenameInfo(fileName, offset, preferences);
		if (renameInfo.canRename === false) {
			// use explicit comparison so that the discriminated union gets resolved properly
			return {
				edits: [],
				rejectReason: renameInfo.localizedErrorMessage
			};
		}
		if (renameInfo.fileToRename !== undefined) {
			throw new Error('Renaming files is not supported.');
		}

		const renameLocations = await worker.findRenameLocations(
			fileName,
			offset,
			/*strings*/ false,
			/*comments*/ false,
			/*prefixAndSuffix*/ !!preferences.providePrefixAndSuffixTextForRename
		);

		if (!renameLocations || model.isDisposed()) {
			return;
		}

		const edits: languages.IWorkspaceTextEdit[] = [];
		const extraLibs = typescriptDefaults.getExtraLibs();
		for (const renameLocation of renameLocations) {
			const fileName = renameLocation.fileName;
			if (fileName in extraLibs) {
				return {
					edits: [],
					rejectReason: 'Cannot rename in extra lib file'
				};
			}
			const model = this._libFiles.getOrCreateModel(fileName);
			if (model) {
				edits.push({
					resource: model.uri,
					versionId: undefined,
					textEdit: {
						range: textSpanToRange(model, renameLocation.textSpan),
						text: newName
					}
				});
			} else {
				throw new Error(`Unknown file ${fileName}.`);
			}
		}

		return { edits };
	}
}

// --- inlay hints ----

export class InlayHintsAdapter extends Adapter implements languages.InlayHintsProvider {
	public async provideInlayHints(
		model: editor.ITextModel,
		range: Range,
		token: CancellationToken
	): Promise<languages.InlayHintList | null> {
		const resource = model.uri;
		const fileName = resource.toString();
		const start = model.getOffsetAt({
			lineNumber: range.startLineNumber,
			column: range.startColumn
		});
		const end = model.getOffsetAt({
			lineNumber: range.endLineNumber,
			column: range.endColumn
		});
		const worker = await this._worker(resource);
		if (model.isDisposed()) {
			return null;
		}

		const tsHints = await worker.provideInlayHints(fileName, start, end);
		const hints: languages.InlayHint[] = tsHints.map((hint) => {
			return {
				...hint,
				label: hint.text,
				position: model.getPositionAt(hint.position),
				kind: this._convertHintKind(hint.kind)
			};
		});
		return { hints, dispose: () => {} };
	}

	private _convertHintKind(kind?: ts.InlayHintKind) {
		switch (kind) {
			case 'Parameter':
				return languages.InlayHintKind.Parameter;
			case 'Type':
				return languages.InlayHintKind.Type;
			default:
				return languages.InlayHintKind.Type;
		}
	}
}
