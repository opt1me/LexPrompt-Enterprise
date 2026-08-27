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

  it('does not publish twice while a publish is already in flight', async () => {
    const onPublish = vi.fn().mockResolvedValue(undefined);
    const c = mount(<PublishDialog nextVersion={1} onPublish={onPublish} onCancel={() => {}} busy />);
    click(buttonNamed(c, /publish/i));
    await flush();
    expect(onPublish).not.toHaveBeenCalled();
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
