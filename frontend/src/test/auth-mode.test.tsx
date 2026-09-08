import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import App from '../App';
import { respond, system } from './fixtures';

it('enters the workspace directly in no-token mode and hides logout', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/session') return respond({ authenticated: true, auth_required: false });
    if (url === '/api/tasks' || url === '/api/library') return respond({ tasks: [] });
    if (url === '/api/system') return respond(system);
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  expect(await screen.findByText('还没有下载任务')).toBeVisible();
  expect(screen.getByText('免令牌')).toBeVisible();
  expect(screen.queryByLabelText('访问令牌')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '退出登录' })).not.toBeInTheDocument();
  expect(fetch.mock.calls.some(([url]) => url === '/api/login')).toBe(false);
});

it('keeps the login form when token authentication is required', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => respond({ authenticated: false, auth_required: true })));
  render(<App />);
  expect(await screen.findByLabelText('访问令牌')).toBeVisible();
  expect(screen.queryByText('免令牌')).not.toBeInTheDocument();
});
