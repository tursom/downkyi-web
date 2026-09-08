import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import Tasks from '../Tasks';
import { respond, task } from './fixtures';

it('keeps removed unfinished storage discoverable and separately deletable', async () => {
  const user = userEvent.setup();
  const fetch = vi.fn(async () => respond({ files: [] }));
  vi.stubGlobal('fetch', fetch);
  render(<Tasks library tasks={[
    {...task, id:'retained', title:'未完成保留任务', status:'paused', record_removed:true},
    {...task, id:'completed', title:'完成的视频', status:'completed'},
  ]} loading={false} error="" refresh={vi.fn()} onNew={vi.fn()} onBrowse={vi.fn()} message=""/>);
  await user.click(screen.getByRole('button', {name:/待清理/}));
  expect(screen.queryByText('完成的视频')).not.toBeInTheDocument();
  expect(screen.getByText('记录已移除 · 临时文件待清理')).toBeVisible();
  await user.click(screen.getByRole('button',{name:'未完成保留任务'}));
  expect(await screen.findByText('保留了未完成的临时文件')).toBeVisible();
  expect(screen.queryByRole('button',{name:'继续下载'})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'删除文件'}));
  expect(screen.getByRole('button',{name:'永久删除文件'})).toBeDisabled();
  await user.click(screen.getByLabelText('我确认删除该任务的全部文件'));
  await user.click(screen.getByRole('button',{name:'永久删除文件'}));
  expect(fetch).toHaveBeenCalledWith('/api/tasks/retained/files',expect.objectContaining({method:'DELETE'}));
});
