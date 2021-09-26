import { Plugin } from 'prosemirror-state';
import { StepMap, Step, Transform } from 'prosemirror-transform';
import { Decoration, DecorationSet } from 'prosemirror-view';

class Span {
  public from: number;
  public to: number;
  public commit?: number;
  constructor(from: number, to: number, commit?: number) {
    this.from = from;
    this.to = to;
    this.commit = commit;
  }
}

export class Commit {
  public message: string;
  public time: Date;
  public steps: Step[];
  public maps: StepMap[];
  public hidden: boolean;
  constructor(
    message: string,
    time: Date,
    steps: Step[],
    maps: StepMap[],
    hidden = false
  ) {
    this.message = message;
    this.time = time;
    this.steps = steps;
    this.maps = maps;
    this.hidden = hidden;
  }

  public toJSON() {
    return {
      message: this.message,
      time: this.time,
      steps: this.steps.map(step => step.toJSON()),
      maps: this.maps.map(map => ({
        ranges: (map as any).ranges,
        inverted: (map as any).inverted,
      })),
    };
  }
}

export class TrackState {
  public blameMap: Span[];
  public commits: Commit[];
  public uncommittedSteps: Step[];
  public uncommittedMaps: StepMap[];

  constructor(
    blameMap: Span[],
    commits: Commit[] = [],
    uncommittedSteps: Step[] = [],
    uncommittedMaps: StepMap[] = []
  ) {
    // The blame map is a data structure that lists a sequence of
    // document ranges, along with the commit that inserted them. This
    // can be used to, for example, highlight the part of the document
    // that was inserted by a commit.
    this.blameMap = blameMap;
    // The commit history, as an array of objects.
    this.commits = commits;
    // Inverted steps and their maps corresponding to the changes that
    // have been made since the last commit.
    this.uncommittedSteps = uncommittedSteps;
    this.uncommittedMaps = uncommittedMaps;
  }

  // Apply a transform to this state
  applyTransform(transform: Transform) {
    // Invert the steps in the transaction, to be able to save them in
    // the next commit
    const inverted = transform.steps.map((step, i: number) =>
      step.invert(transform.docs[i])
    );
    const newBlame = updateBlameMap(
      this.blameMap,
      transform,
      this.commits.length
    );
    // Create a new state—since these are part of the editor state, a
    // persistent data structure, they must not be mutated.
    return new TrackState(
      newBlame,
      this.commits,
      this.uncommittedSteps.concat(inverted),
      this.uncommittedMaps.concat(transform.mapping.maps)
    );
  }

  // When a transaction is marked as a commit, this is used to put any
  // uncommitted steps into a new commit.
  applyCommit(message: string, time: Date) {
    if (!this.uncommittedSteps.length) return this;
    const commit = new Commit(
      message,
      time,
      this.uncommittedSteps,
      this.uncommittedMaps
    );
    return new TrackState(this.blameMap, this.commits.concat(commit), [], []);
  }
}

function updateBlameMap(map: Span[], transform: Transform, id: number) {
  const result: Span[] = [];
  const { mapping } = transform;
  for (let i = 0; i < map.length; i++) {
    const span = map[i];
    const from = mapping.map(span.from, 1);
    const to = mapping.map(span.to, -1);
    if (from < to) result.push(new Span(from, to, span.commit));
  }

  for (let i = 0; i < mapping.maps.length; i++) {
    const map = mapping.maps[i],
      after = mapping.slice(i + 1);
    map.forEach((_s, _e, start, end) => {
      insertIntoBlameMap(result, after.map(start, 1), after.map(end, -1), id);
    });
  }

  return result;
}

function insertIntoBlameMap(
  map: Span[],
  from: number,
  to: number,
  commit: number
) {
  if (from >= to) return;
  let pos = 0;
  let next;
  for (; pos < map.length; pos++) {
    next = map[pos];
    if (next.commit === commit) {
      if (next.to >= from) break;
    } else if (next.to > from) {
      // Different commit, not before
      if (next.from < from) {
        // Sticks out to the left (loop below will handle right side)
        const left = new Span(next.from, from, next.commit);
        if (next.to > to) map.splice(pos++, 0, left);
        else map[pos++] = left;
      }
      break;
    }
  }

  while ((next = map[pos])) {
    if (next.commit === commit) {
      if (next.from > to) break;
      from = Math.min(from, next.from);
      to = Math.max(to, next.to);
      map.splice(pos, 1);
    } else {
      if (next.from >= to) break;
      if (next.to > to) {
        map[pos] = new Span(to, next.to, next.commit);
        break;
      } else {
        map.splice(pos, 1);
      }
    }
  }

  map.splice(pos, 0, new Span(from, to, commit));
}

export const TrackChangesPlugin = new Plugin<TrackState>({
  state: {
    init(_, instance) {
      return new TrackState([new Span(0, instance.doc.content.size)]);
    },
    apply(tr, tracked) {
      if (tr.docChanged) {
        tracked = tracked.applyTransform(tr);
      }
      const commitMessage = tr.getMeta(this);
      if (commitMessage)
        tracked = tracked.applyCommit(commitMessage, new Date(tr.time));
      return tracked;
    },
  },
});

export const highlightPlugin = new Plugin({
  state: {
    init() {
      return { deco: DecorationSet.empty, commit: null };
    },
    apply(tr, prev, oldState, state) {
      const highlight = tr.getMeta(this);
      if (highlight && highlight.add != null && prev.commit !== highlight.add) {
        const { commits, blameMap } = TrackChangesPlugin.getState(oldState);
        const decos = blameMap
          .filter(span => span.commit && commits[span.commit] === highlight.add)
          .map(span =>
            Decoration.inline(span.from, span.to, {
              class: 'commit-blame-marker',
            })
          );
        return {
          deco: DecorationSet.create(state.doc, decos),
          commit: highlight.add,
        };
      } else if (
        highlight &&
        highlight.clear !== null &&
        prev.commit === highlight.clear
      ) {
        return { deco: DecorationSet.empty, commit: null };
      } else if (tr.docChanged && prev.commit) {
        return { deco: prev.deco.map(tr.mapping, tr.doc), commit: prev.commit };
      } else {
        return prev;
      }
    },
  },
  props: {
    decorations(state) {
      return this.getState(state).deco;
    },
  },
});
