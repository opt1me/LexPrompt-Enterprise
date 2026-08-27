import React from 'react';
import { act } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click, type } from '../../test/mount';
import { PublishDialog } from './PublishDialog';

const flush = () => act(async () => { await Promise.resolve(); });
const area = (c: HTMLElement) => c.querySelector('textarea') as HTMLTextAreaElement;

describe('PublishDialog', () => {
  it('names the version it is about to publish', () => {
    const c = mount(<PublishDialog nextVersion={4} onPublish={async () => {}} onCancel={() => {}} />);
    expect(c.textContent).toContain('Publish v4');
  });

  it('refuses to publish without a change summary after v1', async () => {
    const onPublish = vi.fn();
    const c = mount(<PublishDialog nextVersion={2} onPublish={onPublish} onCancel={() => {}} />);
    click(buttonNamed(c, /publish/i));
    await flush();
    expect(onPublish).not.toHaveBeenCalled();
    expect(c.textContent).toMatch(/change summary/i);
  });

  // The refusal has to SAY something, not just do nothing: a Publish button
  // that silently declines is indistinguishable from one that is broken.
  it('says why it refused, in words the reader can act on', async () => {
    const c = mount(<PublishDialog nextVersion={2} onPublish={vi.fn()} onCancel={() => {}} />);
    expect(c.textContent).not.toMatch(/say what changed/i);
    click(buttonNamed(c, /publish/i));
    await flush();
    expect(c.textContent).toMatch(/say what changed/i);
  });

  it('whitespace is not a change summary', async () => {
    const onPublish = vi.fn();
    const c = mount(<PublishDialog nextVersion={2} onPublish={onPublish} onCancel={() => {}} />);
    type(area(c), '   ');
    click(buttonNamed(c, /publish/i));
    await flush();
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('publishes with the summary once one is given', async () => {
    const onPublish = vi.fn().mockResolvedValue(undefined);
    const c = mount(<PublishDialog nextVersion={2} onPublish={onPublish} onCancel={() => {}} />);
    type(area(c), 'Tightened the break-notice position.');
    click(buttonNamed(c, /publish/i));
    await flush();
    expect(onPublish).toHaveBeenCalledWith('Tightened the break-notice position.');
  });

  // v1 has nothing to have changed FROM — requiring a summary there would
  // be asking the author to describe a diff against nothing.
  it('publishes v1 with no change summary', async () => {
    const onPublish = vi.fn().mockResolvedValue(undefined);
    const c = mount(<PublishDialog nextVersion={1} onPublish={onPublish} onCancel={() => {}} />);
    click(buttonNamed(c, /publish/i));
    await flush();
    expect(onPublish).toHaveBeenCalledWith('');
  });

  // DELIBERATELY NOT TESTED: "a click while the `busy` PROP is true does
  // not publish". The test that used to sit here mounted with `busy` already
  // set and asserted `onPublish` was not called — but `Button` sets
  // `disabled = disabled || loading` (src/components/Button.tsx), so the
  // button itself refuses the click and the guard the test named was never
  // reached. Deleting `if (busy) return;` from the component left this file
  // 8/8 green, which the Task 9 review confirmed by mutation. The guard is
  // gone with it: `busy` is a prop, so it is still false for the whole tick
  // in which a double-click lands, and a guard on it cannot close the race
  // it appeared to. The test below closes the real one.
  it('does not publish twice when two clicks land before the parent can mark it busy', async () => {
    let release!: () => void;
    const onPublish = vi.fn().mockReturnValue(new Promise<void>(r => { release = () => r(); }));
    const c = mount(<PublishDialog nextVersion={1} onPublish={onPublish} onCancel={() => {}} />);
    const publish = buttonNamed(c, /publish/i)!;
    click(publish);
    // Second click in the same tick: the parent has had no chance to set
    // `busy`, so only the dialog's own in-flight flag can refuse it.
    click(publish);
    await flush();
    expect(onPublish).toHaveBeenCalledTimes(1);
    release();
    await flush();
  });

  // m6. A refusal that stays on screen beside a now-filled box is telling
  // the author about a problem they have already fixed.
  it('clears the refusal as soon as the author starts typing a summary', async () => {
    const c = mount(<PublishDialog nextVersion={2} onPublish={vi.fn()} onCancel={() => {}} />);
    click(buttonNamed(c, /publish/i));
    await flush();
    expect(c.textContent).toMatch(/say what changed/i);
    type(area(c), 'Tightened the break-notice position.');
    expect(c.textContent).not.toMatch(/say what changed/i);
  });

  // m7. Today's caller swallows its own errors, so a rejection here is
  // latent — but a caller that does not would leave an unhandled rejection
  // and a dialog stuck in flight, unable to try again.
  it('says why a rejected publish failed, and stays usable for a retry', async () => {
    const onPublish = vi.fn()
      .mockRejectedValueOnce(new Error('Could not save — your browser storage is full.'))
      .mockResolvedValue(undefined);
    const c = mount(<PublishDialog nextVersion={1} onPublish={onPublish} onCancel={() => {}} />);
    click(buttonNamed(c, /publish/i));
    await flush();
    expect(c.textContent).toMatch(/storage is full/i);
    click(buttonNamed(c, /publish/i));
    await flush();
    expect(onPublish).toHaveBeenCalledTimes(2);
  });

  it('cancels without publishing', async () => {
    const onPublish = vi.fn();
    const onCancel = vi.fn();
    const c = mount(<PublishDialog nextVersion={2} onPublish={onPublish} onCancel={onCancel} />);
    click(buttonNamed(c, /cancel/i));
    await flush();
    expect(onCancel).toHaveBeenCalled();
    expect(onPublish).not.toHaveBeenCalled();
  });
});
