import { test, expect } from '@playwright/test';

test.describe('Projects API', () => {
  let createdProjectId: string | null = null;

  test('list projects returns array', async ({ request }) => {
    const res = await request.get('/api/projects');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.projects)).toBe(true);
  });

  test('create, rename, and delete project lifecycle', async ({ request }) => {
    // Create
    const createRes = await request.post('/api/projects', {
      data: { name: 'E2E Test Project' },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    expect(createBody.data.project.name).toBe('E2E Test Project');
    createdProjectId = createBody.data.project.id;

    // Rename
    const renameRes = await request.patch(`/api/projects/${createdProjectId}`, {
      data: { name: 'E2E Renamed Project' },
    });
    expect(renameRes.ok()).toBeTruthy();
    const renameBody = await renameRes.json();
    expect(renameBody.data.name).toBe('E2E Renamed Project');

    // Verify in list
    const listRes = await request.get('/api/projects');
    const listBody = await listRes.json();
    const found = listBody.data.projects.find((p: { id: string }) => p.id === createdProjectId);
    expect(found).toBeTruthy();
    expect(found.name).toBe('E2E Renamed Project');

    // Delete
    const deleteRes = await request.delete(`/api/projects/${createdProjectId}`);
    expect(deleteRes.ok()).toBeTruthy();

    // Verify deleted
    const listRes2 = await request.get('/api/projects');
    const listBody2 = await listRes2.json();
    const found2 = listBody2.data.projects.find((p: { id: string }) => p.id === createdProjectId);
    expect(found2).toBeFalsy();
  });

  test('delete non-existent project returns 404', async ({ request }) => {
    const res = await request.delete('/api/projects/does-not-exist-12345');
    expect(res.status()).toBe(404);
  });
});
