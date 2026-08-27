import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttons, click } from '../../test/mount';
import { EvidenceList } from './EvidenceList';

const CITATIONS = [
  { quote: 'Liability is capped at the Charges.', documentId: 'doc-1', page: 2 },
  { quote: 'Notices must be in writing.', documentId: 'doc-1' },
];

describe('EvidenceList', () => {
  it('shows each quote as readable text, not only on hover', () => {
    const c = mount(<EvidenceList citations={CITATIONS} documentNames={{ 'doc-1': 'MSA.pdf' }} onCiteClick={() => {}} />);
    expect(c.textContent).toMatch(/Liability is capped at the Charges\./);
    expect(c.textContent).toMatch(/Notices must be in writing\./);
  });

  it('pins a citation to its document and page', () => {
    const c = mount(<EvidenceList citations={CITATIONS} documentNames={{ 'doc-1': 'MSA.pdf' }} onCiteClick={() => {}} />);
    expect(c.textContent).toMatch(/MSA\.pdf.*p\.\s*2/);
  });

  it('says the document name alone when no page could be derived', () => {
    const c = mount(<EvidenceList citations={[CITATIONS[1]]} documentNames={{ 'doc-1': 'MSA.pdf' }} onCiteClick={() => {}} />);
    const pin = Array.from(c.querySelectorAll('span')).find(el => /MSA\.pdf/.test(el.textContent || ''));
    expect(pin).toBeTruthy();
    expect(pin!.textContent).not.toMatch(/p\./);
  });

  it('falls back to the document id when the name is unknown', () => {
    const c = mount(<EvidenceList citations={[CITATIONS[1]]} documentNames={{}} onCiteClick={() => {}} />);
    expect(c.textContent).toMatch(/doc-1/);
  });

  it('shows a clauseRef when the model supplied one', () => {
    const c = mount(
      <EvidenceList
        citations={[{ quote: 'q that is long enough', documentId: 'doc-1', clauseRef: '14.2' }]}
        documentNames={{ 'doc-1': 'MSA.pdf' }}
        onCiteClick={() => {}}
      />,
    );
    expect(c.textContent).toMatch(/14\.2/);
  });

  it('hands the clicked quote to the viewer', () => {
    const onCiteClick = vi.fn();
    const c = mount(<EvidenceList citations={CITATIONS} documentNames={{}} onCiteClick={onCiteClick} />);
    click(buttons(c)[0]);
    expect(onCiteClick).toHaveBeenCalledWith(['Liability is capped at the Charges.']);
  });

  it('renders nothing at all when there are no citations', () => {
    const c = mount(<EvidenceList citations={[]} documentNames={{}} onCiteClick={() => {}} />);
    expect(c.textContent).toBe('');
  });
});
