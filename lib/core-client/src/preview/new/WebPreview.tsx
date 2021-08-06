import React, { ComponentType } from 'react';
import ReactDOM from 'react-dom';
import Events from '@storybook/core-events';
import { logger } from '@storybook/client-logger';
import global from 'global';
import { addons, Channel } from '@storybook/addons';
import createChannel from '@storybook/channel-postmessage';
import fetch from 'unfetch';

import {
  WebGlobalMeta,
  ModuleImportFn,
  Selection,
  Story,
  RenderContextWithoutStoryContext,
  RenderContext,
  GlobalMeta,
  Globals,
  StoryId,
  Args,
  DocsContextProps,
  StorySpecifier,
  Parameters,
  CSFFile,
} from '@storybook/client-api/dist/ts3.9/new/types';
import { StoryStore } from '@storybook/client-api/dist/esm/new/StoryStore';

import { UrlStore } from './UrlStore';
import { WebView } from './WebView';
import { NoDocs } from '../NoDocs';

const { window: globalWindow } = global;

// TODO -- what's up with this code? Is it for HMR? Can we be smarter?
function getOrCreateChannel() {
  try {
    return addons.getChannel();
  } catch (err) {
    const channel = createChannel({ page: 'preview' });
    addons.setChannel(channel);
    return channel;
  }
}

function focusInInput(event: Event) {
  const target = event.target as Element;
  return /input|textarea/i.test(target.tagName) || target.getAttribute('contenteditable') !== null;
}

export class WebPreview<StoryFnReturnType> {
  channel: Channel;

  urlStore: UrlStore;

  storyStore: StoryStore<StoryFnReturnType>;

  view: WebView;

  renderToDOM: WebGlobalMeta<StoryFnReturnType>['renderToDOM'];

  previousSelection: Selection;

  previousStory: Story<StoryFnReturnType>;

  constructor({
    getGlobalMeta,
    importFn,
  }: {
    getGlobalMeta: () => WebGlobalMeta<StoryFnReturnType>;
    importFn: ModuleImportFn;
  }) {
    console.log('creating WebPreview');
    this.channel = getOrCreateChannel();

    const globalMeta = this.getGlobalMetaOrRenderError(getGlobalMeta);
    if (!globalMeta) {
      return;
    }

    const fetchStoriesList = async () => {
      const response = await fetch('/stories.json');
      return response.json();
    };

    this.urlStore = new UrlStore();
    this.storyStore = new StoryStore({ importFn, globalMeta, fetchStoriesList });
    this.view = new WebView();

    this.initialize();
  }

  getGlobalMetaOrRenderError(
    getGlobalMeta: () => WebGlobalMeta<StoryFnReturnType>
  ): GlobalMeta<StoryFnReturnType> | undefined {
    let globalMeta;
    try {
      globalMeta = getGlobalMeta();
      this.renderToDOM = globalMeta.renderToDOM;
      return globalMeta;
    } catch (err) {
      // This is an error extracting the globalMeta (i.e. evaluating the previewEntries) and
      // needs to be show to the user as a simple error
      this.renderPreviewEntryError(err);
      return undefined;
    }
  }

  async initialize() {
    await this.storyStore.initialize();
    this.setupListeners();
    await this.selectSpecifiedStory();

    // TODO are we doing this? back-compat?
    // TODO -- which way round is SET_STORIES/STORY_WAS_SELECTED in 6.3?
    // this.channel.emit(Events.SET_STORIES, this.storyStore.getSetStoriesPayload());
  }

  setupListeners() {
    globalWindow.onkeydown = this.onKeydown.bind(this);

    this.channel.on(Events.SET_CURRENT_STORY, this.onSetCurrentStory.bind(this));
    this.channel.on(Events.UPDATE_GLOBALS, this.onUpdateGlobals.bind(this));
    this.channel.on(Events.UPDATE_STORY_ARGS, this.onUpdateArgs.bind(this));
    this.channel.on(Events.RESET_STORY_ARGS, this.onResetArgs.bind(this));
  }

  // Use the selection specifier to choose a story
  async selectSpecifiedStory() {
    const { storySpecifier, viewMode, globals, args } = this.urlStore.selectionSpecifier;
    const storyId = this.storyStore.storiesList.storyIdFromSpecifier(storySpecifier);

    if (!storyId) {
      this.renderMissingStory(storySpecifier);
      return;
    }

    this.urlStore.setSelection({ storyId, viewMode });
    this.channel.emit(Events.STORY_SPECIFIED, this.urlStore.selection);

    // TODO -- previously this only emitted if the selection failed. I don't know if we really need it
    this.channel.emit(Events.CURRENT_STORY_WAS_SET, this.urlStore.selection);

    if (globals) {
      this.storyStore.globals.updateFromPersisted(globals);
    }

    await this.renderSelection({ forceRender: false, persistedArgs: args });
  }

  onKeydown(event: KeyboardEvent) {
    if (!focusInInput(event)) {
      // We have to pick off the keys of the event that we need on the other side
      const { altKey, ctrlKey, metaKey, shiftKey, key, code, keyCode } = event;
      this.channel.emit(Events.PREVIEW_KEYDOWN, {
        event: { altKey, ctrlKey, metaKey, shiftKey, key, code, keyCode },
      });
    }
  }

  onSetCurrentStory(selection: Selection) {
    this.urlStore.setSelection(selection);
    this.channel.emit(Events.CURRENT_STORY_WAS_SET, this.urlStore.selection);
    this.renderSelection({ forceRender: false });
  }

  onUpdateGlobals({ globals }: { globals: Globals }) {
    this.storyStore.globals.update(globals);

    this.channel.emit(Events.GLOBALS_UPDATED, {
      globals,
      initialGlobals: this.storyStore.globals.initialGlobals,
    });

    this.renderSelection({ forceRender: true });
  }

  onUpdateArgs({ storyId, updatedArgs }: { storyId: StoryId; updatedArgs: Args }) {
    this.storyStore.args.update(storyId, updatedArgs);
    this.channel.emit(Events.STORY_ARGS_UPDATED, {
      storyId,
      args: this.storyStore.args.get(storyId),
    });
    this.renderSelection({ forceRender: true });
  }

  async onResetArgs({ storyId, argNames }: { storyId: string; argNames?: string[] }) {
    const { initialArgs } = await this.storyStore.loadStory({ storyId });

    // TODO ensure this technique works with falsey/null initialArgs
    const updatedArgs = argNames.reduce((acc, argName) => {
      acc[argName] = initialArgs[argName];
      return acc;
    }, {} as Partial<Args>);

    this.onUpdateArgs({ storyId, updatedArgs });
  }

  // This happens when a glob gets HMR-ed
  onImportFnChanged({ importFn }: { importFn: ModuleImportFn }) {
    this.storyStore.importFn = importFn;
    this.renderSelection({ forceRender: false });
  }

  // This happens when a config file gets reloade
  onGetGlobalMetaChanged({
    getGlobalMeta,
  }: {
    getGlobalMeta: () => GlobalMeta<StoryFnReturnType>;
  }) {
    const globalMeta = this.getGlobalMetaOrRenderError(getGlobalMeta);
    if (!globalMeta) {
      return;
    }

    this.storyStore.globalMeta = globalMeta;
    this.renderSelection({ forceRender: false });
  }

  // We can either have:
  // - a story selected in "story" viewMode,
  //     in which case we render it to the root element, OR
  // - a story selected in "docs" viewMode,
  //     in which case we render the docsPage for that story
  async renderSelection({
    forceRender,
    persistedArgs,
  }: {
    forceRender: boolean;
    persistedArgs?: Args;
  }) {
    if (!this.urlStore.selection) {
      throw new Error('Cannot render story as no selection was made');
    }

    const { selection } = this.urlStore;

    const story = await this.storyStore.loadStory({ storyId: selection.storyId });
    if (persistedArgs) {
      this.storyStore.args.updateFromPersisted(story, persistedArgs);
    }

    const storyChanged = this.previousSelection?.storyId !== selection.storyId;
    const viewModeChanged = this.previousSelection?.viewMode !== selection.viewMode;

    const implementationChanged = story !== this.previousStory;

    if (this.previousSelection?.viewMode === 'story' && (storyChanged || viewModeChanged)) {
      this.removeStory({ story: this.previousStory });
    }

    if (viewModeChanged && this.previousSelection?.viewMode === 'docs') {
      ReactDOM.unmountComponentAtNode(this.view.docsRoot());
    }

    // Don't re-render the story if nothing has changed to justify it
    if (!forceRender && !storyChanged && !implementationChanged && !viewModeChanged) {
      // TODO -- the api of this changed, but the previous API made no sense. Did we use it?
      this.channel.emit(Events.STORY_UNCHANGED, selection.storyId);
      return;
    }

    // If we are rendering something new (as opposed to re-rendering the same or first story), emit
    if (this.previousSelection && (storyChanged || viewModeChanged)) {
      this.channel.emit(Events.STORY_CHANGED, selection.storyId);
    }

    // Record the previous selection *before* awaiting the rendering, in cases things change before it is done.
    this.previousSelection = selection;
    this.previousStory = story;

    if (selection.viewMode === 'docs') {
      await this.renderDocs({ story });
    } else {
      await this.renderStory({ story, forceRender });
    }
  }

  async renderDocs({ story }: { story: Story<StoryFnReturnType> }) {
    const { id, title, name } = story;
    const element = this.view.prepareForDocs();
    const csfFile: CSFFile<StoryFnReturnType> = await this.storyStore.loadCSFFileByStoryId(id);
    const docsContext = {
      id,
      title,
      name,
      // NOTE: these two functions are *sync* so cannot access stories from other CSF files
      storyById: (storyId: StoryId) => this.storyStore.storyFromCSFFile({ storyId, csfFile }),
      componentStories: () => this.storyStore.componentStoriesFromCSFFile({ csfFile }),
      renderStoryToElement: this.renderStoryToElement.bind(this),

      // TODO -- this is for prepareForInline. Note this *DOES NOT* run loaders,
      // or play, or any of the stuff that `renderStoryToElement` below does.
      // If we want to stick with this approach, we should refactor to share code.
      bindStoryFn: (renderedStory: Story<StoryFnReturnType>) => () =>
        renderedStory.storyFn(this.storyStore.getStoryContext(renderedStory)),
    };

    const { docs } = story.parameters;
    if (docs?.page && !docs?.container) {
      throw new Error('No `docs.container` set, did you run `addon-docs/preset`?');
    }

    const DocsContainer: ComponentType<{ context: DocsContextProps<StoryFnReturnType> }> =
      docs.container || (({ children }: { children: Element }) => <>{children}</>);
    const Page: ComponentType = docs.page || NoDocs;

    const docsElement = (
      <DocsContainer context={docsContext}>
        <Page />
      </DocsContainer>
    );
    ReactDOM.render(docsElement, element, () =>
      // TODO -- changed the API, previous it had a kind -- did we use it?
      this.channel.emit(Events.DOCS_RENDERED, id)
    );
  }

  async renderStory({
    story,
    forceRender,
  }: {
    story: Story<StoryFnReturnType>;
    forceRender: boolean;
  }) {
    const element = this.view.prepareForStory(story, forceRender);
    const { id, title, name } = story;
    const renderContext: RenderContextWithoutStoryContext = {
      id,
      title,
      kind: title,
      name,
      story: name,
      forceRender,
      showMain: () => this.view.showMain(),
      showError: (err: { title: string; description: string }) => this.renderError(err),
      showException: (err: Error) => this.renderException(err),
    };

    await this.renderStoryToElement({ story, renderContext, element });
  }

  // We want this function to be called directly by `renderSelection` above,
  // but also by the `<ModernStory>` docs component
  async renderStoryToElement({
    story,
    renderContext: renderContextWithoutStoryContext,
    element,
  }: {
    story: Story<StoryFnReturnType>;
    renderContext: RenderContextWithoutStoryContext;
    element: Element;
  }) {
    const { id, applyLoaders, storyFn, runPlayFunction } = story;

    const storyContext = this.storyStore.getStoryContext(story);

    const { name, title, parameters, initialArgs, argTypes, args } = storyContext;
    this.channel.emit(Events.STORY_PREPARED, {
      id,
      parameters,
      initialArgs,
      argTypes,
      args,
    });
    const loadedContext = await applyLoaders(storyContext);

    const renderContext: RenderContext<StoryFnReturnType> = {
      ...renderContextWithoutStoryContext,
      unboundStoryFn: storyFn,
      storyContext: {
        ...loadedContext,
        storyFn: () => storyFn(loadedContext),
      },
    };
    await this.renderToDOM(renderContext, element);

    if (!renderContext.forceRender) {
      await runPlayFunction();
    }
    this.channel.emit(Events.STORY_RENDERED, id);
  }

  removeStory({ story }: { story: Story<StoryFnReturnType> }) {
    story.cleanup();
  }

  renderPreviewEntryError(err: Error) {
    this.view.showErrorDisplay(err);
    // TODO -- should we emit here?
  }

  renderMissingStory(storySpecifier: StorySpecifier) {
    this.view.showNoPreview();
    this.channel.emit(Events.STORY_MISSING, storySpecifier);
  }

  // renderException is used if we fail to render the story and it is uncaught by the app layer
  renderException(err: Error) {
    this.view.showErrorDisplay(err);
    this.channel.emit(Events.STORY_THREW_EXCEPTION, err);

    // Log the stack to the console. So, user could check the source code.
    logger.error(err);
  }

  // renderError is used by the various app layers to inform the user they have done something
  // wrong -- for instance returned the wrong thing from a story
  renderError({ title, description }: { title: string; description: string }) {
    this.channel.emit(Events.STORY_ERRORED, { title, description });
    this.view.showErrorDisplay({
      message: title,
      stack: description,
    });
  }
}