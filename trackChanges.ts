import { Extension } from '@tiptap/core';
//import { CommandProps } from '@tiptap/react';
import { Mapping, StepMap } from 'prosemirror-transform';

import {
  highlightPlugin,
  TrackChangesPlugin,
  Commit,
} from './trackChangesPlugin2';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    trackChanges: {
      //getCommits: () => (props: CommandProps) => Commit[];
      getCommits: () => (props: any) => Commit[];
      doCommit: (message: string) => ReturnType;
      revertCommit: (commit: Commit) => ReturnType;
      highlightCommit: (commit: Commit) => ReturnType;
      clearHighlightCommit: (commit: Commit) => ReturnType;
      applyCommit: (message: string, time: Date) => ReturnType;
    };
  }
}

export const TrackChanges = Extension.create({
  name: 'trackChanges',

  defaultOptions: {
    pluginKey: 'trackChanges',
  },

  addCommands() {
    return {
      getCommits:
        () =>
        ({ state }) => {
          const trackState = TrackChangesPlugin.getState(state);
          return trackState.commits; //as unknown as true;
        },
      doCommit: (message: string) => data => {
        const { state } = data;
        state.tr.setMeta(TrackChangesPlugin, message);
        return true;
      },

      revertCommit:
        (commit: Commit) =>
        ({ state }) => {
          const trackState = TrackChangesPlugin.getState(state);
          const index = trackState.commits.indexOf(commit);
          // If this commit is not in the history, we can't revert it
          if (index === -1) return false;

          // Reverting is only possible if there are no uncommitted changes
          if (trackState.uncommittedSteps.length) {
            alert('Commit your changes first!');
            return false;
          }

          // This is the mapping from the document as it was at the start of
          // the commit to the current document.
          const remap = new Mapping(
            trackState.commits
              .slice(index)
              .reduce((maps, c) => maps.concat(c.maps), [] as StepMap[])
          );
          const tr = state.tr;
          // Build up a transaction that includes all (inverted) steps in this
          // commit, rebased to the current document. They have to be applied
          // in reverse order.
          for (let i = commit.steps.length - 1; i >= 0; i--) {
            // The mapping is sliced to not include maps for this step and the
            // ones before it.
            const remapped = commit.steps[i].map(remap.slice(i + 1));
            if (!remapped) continue;
            const result = tr.maybeStep(remapped);
            // If the step can be applied, add its map to our mapping
            // pipeline, so that subsequent steps are mapped over it.
            if (result.doc) remap.appendMap(remapped.getMap(), i);
          }
          // Add a commit message and dispatch.
          if (tr.docChanged)
            tr.setMeta(TrackChangesPlugin, `Revert '${commit.message}'`);

          return true;
        },
      highlightCommit:
        commit =>
        ({ state }) => {
          state.tr.setMeta(highlightPlugin, { add: commit });
          return true;
        },
      clearHighlightCommit:
        commit =>
        ({ state }) => {
          state.tr.setMeta(highlightPlugin, { clear: commit });
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [TrackChangesPlugin, highlightPlugin];
  },
});
