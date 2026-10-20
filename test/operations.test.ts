import { describe, expect, it } from 'vitest';
import { operations, operationTools } from '../src/operations';

describe('generated operations', () => {
  it('covers both ClickUp API versions', () => {
    expect(operations.length).toBeGreaterThanOrEqual(170);
    expect(operations.some((op) => op.base === 'https://api.clickup.com/api' && op.path.startsWith('/v2/'))).toBe(true);
    expect(operations.some((op) => op.base === 'https://api.clickup.com' && op.path.startsWith('/api/v3/'))).toBe(true);
  });

  it('has a parameter for every path placeholder', () => {
    for (const op of operations) {
      const placeholders = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
      const pathParams = op.params.filter((p) => p.in === 'path').map((p) => p.wire).sort();
      expect(pathParams, op.name).toEqual(placeholders);
    }
  });

  it('produces tool names and property names that every major client accepts', () => {
    const names = new Set<string>();
    for (const tool of operationTools) {
      expect(tool.name).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      expect(tool.inputSchema.type).toBe('object');
      for (const prop of Object.keys(tool.inputSchema.properties as object)) expect(prop).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
      expect(JSON.stringify(tool.inputSchema)).not.toContain('$ref');
    }
  });

  it('includes the operations the official ClickUp MCP lacks', () => {
    const names = new Set(operations.map((op) => op.name));
    for (const name of [
      'clickup_create_checklist',
      'clickup_create_checklist_item',
      'clickup_set_custom_field_value',
      'clickup_create_goal',
      'clickup_create_key_result',
      'clickup_create_webhook',
      'clickup_create_list_view',
      'clickup_get_view_tasks',
      'clickup_create_space',
      'clickup_create_space_tag',
      'clickup_invite_guest_to_workspace',
      'clickup_create_user_group',
      'clickup_create_task_from_template',
      'clickup_query_audit_logs',
      'clickup_update_acl',
      'clickup_create_doc',
      'clickup_edit_doc_page',
      'clickup_move_task',
      'clickup_update_time_estimates_by_user',
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it('marks reads and deletes in annotations', () => {
    const byName = new Map(operationTools.map((t) => [t.name, t]));
    expect(byName.get('clickup_get_task')!.annotations.readOnlyHint).toBe(true);
    expect(byName.get('clickup_query_audit_logs')!.annotations.readOnlyHint).toBe(true);
    expect(byName.get('clickup_delete_task')!.annotations.destructiveHint).toBe(true);
    expect(byName.get('clickup_create_task')!.annotations.readOnlyHint).toBe(false);
  });

  it('makes workspace path parameters optional', () => {
    const tool = operationTools.find((t) => t.name === 'clickup_get_spaces')!;
    expect(tool.inputSchema.required ?? []).not.toContain('team_id');
    expect(Object.keys(tool.inputSchema.properties as object)).toContain('team_id');
  });
});
