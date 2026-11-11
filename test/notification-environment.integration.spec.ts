import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { deliverNotificationEmails } from "../src/notifications";

it.each(["https://app-staging.maltworks.com.br", "https://app.maltworks.com.br"])(
  "notification email opens the configured portal %s (local D1, fake sender)", async origin => {
    const id = origin.includes("staging") ? "mail-stage" : "mail-prod";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?1, ?1, ?1, 1, 1)").bind(id),
      env.DB.prepare(`INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name, created_at, updated_at)
        VALUES (?1, ?2, 'test', 'test', 1, 'QA', 1, 1)`).bind(id, id + "@example.test"),
      env.DB.prepare("INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES (?1, ?1, 'owner', 1)").bind(id),
      env.DB.prepare(`INSERT INTO notification_preferences (user_id, organization_id, email_enabled, updated_at)
        VALUES (?1, ?1, 1, 1)`).bind(id),
      env.DB.prepare(`INSERT INTO notifications (id, organization_id, event_key, category, type, severity, title, message, created_at)
        VALUES (?1, ?1, ?1, 'device', 'online', 'info', 'Online', 'Simulated controller', 1)`).bind(id),
    ]);
    const send = vi.fn<Env["EMAIL"]["send"]>().mockResolvedValue({ messageId: "local-only" });
    // Replace only the external mail service; all selection/delivery SQL runs in local D1.
    const testEnv = Object.assign({}, env, { APP_ORIGIN: origin, EMAIL: { send } });
    await deliverNotificationEmails(testEnv, [id]);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({
      to: id + "@example.test", html: expect.stringContaining(`href="${origin}"`),
    });
    expect(await env.DB.prepare("SELECT status FROM notification_deliveries WHERE notification_id = ?1")
      .bind(id).first()).toEqual({ status: "sent" });
  },
);
