import { describe, it, expect, vi } from 'vitest';
import { mount, mountOnce, keyDown, keyDownOn } from '../../test/mount';
import { useVerifyKeys } from './useVerifyKeys';

function Harness(props: Parameters<typeof useVerifyKeys>[0] & { withInput?: boolean }) {
  useVerifyKeys(props);
  return props.withInput ? <textarea data-testid="box" /> : null;
}

describe('useVerifyKeys', () => {
  it('moves to the next finding on j and ArrowDown', () => {
    const onIndexChange = vi.fn();
    mount(<Harness enabled count={3} index={0} onIndexChange={onIndexChange} onVerify={() => {}} />);
    keyDown({ key: 'j' });
    expect(onIndexChange).toHaveBeenCalledWith(1);
    keyDown({ key: 'ArrowDown' });
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it('moves to the previous finding on k and ArrowUp', () => {
    const onIndexChange = vi.fn();
    mount(<Harness enabled count={3} index={2} onIndexChange={onIndexChange} onVerify={() => {}} />);
    keyDown({ key: 'k' });
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it('stops at the ends rather than wrapping', () => {
    const onIndexChange = vi.fn();
    const first = mountOnce(
      <Harness enabled count={3} index={0} onIndexChange={onIndexChange} onVerify={() => {}} />,
    );
    keyDown({ key: 'k' });
    expect(onIndexChange).not.toHaveBeenCalled();
    first.unmount();

    mount(<Harness enabled count={3} index={2} onIndexChange={onIndexChange} onVerify={() => {}} />);
    keyDown({ key: 'j' });
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('verifies on v and flags on f', () => {
    const onVerify = vi.fn();
    mount(<Harness enabled count={3} index={1} onIndexChange={() => {}} onVerify={onVerify} />);
    keyDown({ key: 'v' });
    expect(onVerify).toHaveBeenCalledWith(1, { state: 'verified' });
    keyDown({ key: 'f' });
    expect(onVerify).toHaveBeenCalledWith(1, { state: 'flagged' });
  });

  it('asks for a rejection rather than rejecting outright on r', () => {
    const onVerify = vi.fn();
    mount(<Harness enabled count={3} index={1} onIndexChange={() => {}} onVerify={onVerify} />);
    keyDown({ key: 'r' });
    expect(onVerify).toHaveBeenCalledWith(1, { state: 'rejected' });
  });

  it('ignores keys while the user is typing', () => {
    const onVerify = vi.fn();
    const c = mount(
      <Harness withInput enabled count={3} index={0} onIndexChange={() => {}} onVerify={onVerify} />,
    );
    const box = c.querySelector('[data-testid="box"]') as HTMLElement;
    box.focus();
    keyDownOn(box, { key: 'v' });
    expect(onVerify).not.toHaveBeenCalled();
  });

  it('ignores keys with a modifier held, so browser shortcuts still work', () => {
    const onVerify = vi.fn();
    mount(<Harness enabled count={3} index={0} onIndexChange={() => {}} onVerify={onVerify} />);
    keyDown({ key: 'v', metaKey: true });
    keyDown({ key: 'v', ctrlKey: true });
    expect(onVerify).not.toHaveBeenCalled();
  });

  it('does nothing at all when disabled', () => {
    const onVerify = vi.fn();
    const onIndexChange = vi.fn();
    mount(<Harness enabled={false} count={3} index={0} onIndexChange={onIndexChange} onVerify={onVerify} />);
    keyDown({ key: 'v' });
    keyDown({ key: 'j' });
    expect(onVerify).not.toHaveBeenCalled();
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('unbinds on unmount', () => {
    const onVerify = vi.fn();
    const { unmount } = mountOnce(
      <Harness enabled count={3} index={0} onIndexChange={() => {}} onVerify={onVerify} />,
    );
    unmount();
    keyDown({ key: 'v' });
    expect(onVerify).not.toHaveBeenCalled();
  });
});
