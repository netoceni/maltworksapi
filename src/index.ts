import { bootstrap, login, logout, me, resetPassword, signup } from "./auth";
import {
  createAlarmCommand,
  createConfigurationCommand,
  createProfileCommand,
  createSetpointCommand,
} from "./commands";
import {
  claimDevice,
  deleteDevice,
  deviceHistory,
  latestDeviceState,
  listDevices,
  updateDevice,
} from "./devices";
import { addCors, errorResponse, jsonResponse, preflightResponse } from "./http";
import { ingestTelemetry } from "./telemetry";
import { createRecipe, deleteRecipe, listRecipes, updateRecipe } from "./recipes";
import {
  addGravityReading,
  deleteGravityReading,
  finishFermentation,
  getFermentation,
  startFermentation,
} from "./fermentation";
import { ApiError } from "./types";
import { createSalesLead } from "./sales";
import { adminListUsers, adminMe, adminOverview } from "./admin";
import {
  deleteAllNotifications,
  deleteNotification,
  getNotificationPreferences,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  scanOfflineDevices,
  updateNotificationPreferences,
} from "./notifications";
import { openBrowserRealtime, openDeviceRealtime, RealtimeHub } from "./realtime";
import {
  adminCreateCampaign,
  adminListCampaigns,
  adminListFirmware,
  adminListOtaDevices,
  adminUpdateCampaign,
  adminUploadFirmware,
  deviceOtaCheck,
  deviceOtaEvent,
  deviceOtaFirmware,
} from "./ota";
import {
  addBatchIngredient,
  addBatchJournalEntry,
  compareBatches,
  deleteBatchAttachment,
  deleteBatchIngredient,
  deleteBatchJournalEntry,
  downloadBatchAttachment,
  getBatch,
  listBatches,
  updateBatch,
  uploadBatchAttachment,
} from "./batches";

export { RealtimeHub };

const API_VERSION = "5.13.1";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      if (request.method === "OPTIONS") return preflightResponse(request, env);
      const response = await route(request, env, requestId, ctx);
      return addCors(response, request, env);
    } catch (error) {
      return addCors(errorResponse(error, requestId), request, env);
    }
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(scanOfflineDevices(env));
  },
} satisfies ExportedHandler<Env>;

async function route(
  request: Request,
  env: Env,
  requestId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/u, "") || "/";

  if (request.method === "GET" && path === "/") {
    return jsonResponse({
      ok: true,
      service: "Maltworks Cloud API",
      version: API_VERSION,
      documentation: "https://maltworks.com.br",
      requestId,
    });
  }

  if (request.method === "GET" && path === "/health") {
    const result = await env.DB.prepare("SELECT 1 AS healthy").first<{ healthy: number }>();
    return jsonResponse({ ok: result?.healthy === 1, version: API_VERSION, requestId });
  }

  if (request.method === "POST" && path === "/v1/telemetry") {
    return ingestTelemetry(request, env, requestId, ctx);
  }
  if (request.method === "GET" && path === "/v1/realtime") {
    return openBrowserRealtime(request, env);
  }
  if (request.method === "GET" && path === "/v1/device/realtime") {
    return openDeviceRealtime(request, env);
  }
  if (request.method === "GET" && path === "/v1/device/ota") {
    return deviceOtaCheck(request, env, requestId);
  }
  const deviceOtaFirmwareMatch = /^\/v1\/device\/ota\/(otaj_[0-9a-f]{32})\/firmware$/u.exec(path);
  if (request.method === "GET" && deviceOtaFirmwareMatch?.[1]) {
    return deviceOtaFirmware(request, env, deviceOtaFirmwareMatch[1]);
  }
  const deviceOtaEventMatch = /^\/v1\/device\/ota\/(otaj_[0-9a-f]{32})\/events$/u.exec(path);
  if (request.method === "POST" && deviceOtaEventMatch?.[1]) {
    return deviceOtaEvent(request, env, requestId, deviceOtaEventMatch[1]);
  }
  if (request.method === "POST" && path === "/v1/sales/leads") {
    return createSalesLead(request, env, requestId);
  }
  if (request.method === "POST" && path === "/v1/auth/bootstrap") {
    return bootstrap(request, env, requestId);
  }
  if (request.method === "POST" && path === "/v1/auth/login") {
    return login(request, env, requestId);
  }
  if (request.method === "POST" && path === "/v1/auth/signup") {
    return signup(request, env, requestId);
  }
  if (request.method === "POST" && path === "/v1/auth/recovery/reset-password") {
    return resetPassword(request, env, requestId);
  }
  if (request.method === "POST" && path === "/v1/auth/logout") {
    return logout(request, env, requestId);
  }
  if (request.method === "GET" && path === "/v1/me") {
    return me(request, env, requestId);
  }
  if (request.method === "GET" && path === "/v1/admin/me") {
    return adminMe(request, env, requestId);
  }
  if (request.method === "GET" && path === "/v1/admin/overview") {
    return adminOverview(request, env, requestId);
  }
  if (request.method === "GET" && path === "/v1/admin/users") {
    return adminListUsers(request, env, requestId);
  }
  if (request.method === "GET" && path === "/v1/admin/firmware") {
    return adminListFirmware(request, env, requestId);
  }
  if (request.method === "POST" && path === "/v1/admin/firmware") {
    return adminUploadFirmware(request, env, requestId);
  }
  if (request.method === "GET" && path === "/v1/admin/ota/devices") {
    return adminListOtaDevices(request, env, requestId);
  }
  if (request.method === "GET" && path === "/v1/admin/ota/campaigns") {
    return adminListCampaigns(request, env, requestId);
  }
  if (request.method === "POST" && path === "/v1/admin/ota/campaigns") {
    return adminCreateCampaign(request, env, requestId);
  }
  const adminCampaignMatch = /^\/v1\/admin\/ota\/campaigns\/(ota_[0-9a-f]{32})$/u.exec(path);
  if (request.method === "PUT" && adminCampaignMatch?.[1]) {
    return adminUpdateCampaign(request, env, requestId, adminCampaignMatch[1]);
  }
  if (request.method === "POST" && path === "/v1/devices/claim") {
    return claimDevice(request, env, requestId);
  }
  if (request.method === "GET" && path === "/v1/devices") {
    return listDevices(request, env, requestId);
  }
  if (request.method === "GET" && path === "/v1/recipes") {
    return listRecipes(request, env, requestId);
  }
  if (request.method === "POST" && path === "/v1/recipes") {
    return createRecipe(request, env, requestId);
  }
  if (request.method === "GET" && path === "/v1/batches") {
    return listBatches(request, env, requestId);
  }
  if (request.method === "GET" && path === "/v1/batches/compare") {
    return compareBatches(request, env, requestId);
  }
  if (request.method === "GET" && path === "/v1/notifications") {
    return listNotifications(request, env, requestId);
  }
  if (request.method === "DELETE" && path === "/v1/notifications") {
    return deleteAllNotifications(request, env, requestId);
  }
  if (request.method === "POST" && path === "/v1/notifications/read-all") {
    return markAllNotificationsRead(request, env, requestId);
  }
  if (request.method === "GET" && path === "/v1/notifications/preferences") {
    return getNotificationPreferences(request, env, requestId);
  }
  if (request.method === "PUT" && path === "/v1/notifications/preferences") {
    return updateNotificationPreferences(request, env, requestId);
  }

  const notificationReadMatch = /^\/v1\/notifications\/(ntf_[0-9a-f]{32})\/read$/u.exec(path);
  if (request.method === "POST" && notificationReadMatch?.[1]) {
    return markNotificationRead(request, env, requestId, notificationReadMatch[1]);
  }
  const notificationMatch = /^\/v1\/notifications\/(ntf_[0-9a-f]{32})$/u.exec(path);
  if (request.method === "DELETE" && notificationMatch?.[1]) {
    return deleteNotification(request, env, requestId, notificationMatch[1]);
  }

  const recipeMatch = /^\/v1\/recipes\/(rcp_[0-9a-f]{32})$/u.exec(path);
  if (request.method === "PUT" && recipeMatch?.[1]) {
    return updateRecipe(request, env, requestId, recipeMatch[1]);
  }
  if (request.method === "DELETE" && recipeMatch?.[1]) {
    return deleteRecipe(request, env, requestId, recipeMatch[1]);
  }

  const batchMatch = /^\/v1\/batches\/(fer_[0-9a-f]{32})$/u.exec(path);
  if (request.method === "GET" && batchMatch?.[1]) {
    return getBatch(request, env, requestId, batchMatch[1]);
  }
  if (request.method === "PUT" && batchMatch?.[1]) {
    return updateBatch(request, env, requestId, batchMatch[1]);
  }
  const batchIngredientsMatch = /^\/v1\/batches\/(fer_[0-9a-f]{32})\/ingredients$/u.exec(path);
  if (request.method === "POST" && batchIngredientsMatch?.[1]) {
    return addBatchIngredient(request, env, requestId, batchIngredientsMatch[1]);
  }
  const batchIngredientMatch = /^\/v1\/batches\/(fer_[0-9a-f]{32})\/ingredients\/(bgi_[0-9a-f]{32})$/u.exec(path);
  if (request.method === "DELETE" && batchIngredientMatch?.[1] && batchIngredientMatch[2]) {
    return deleteBatchIngredient(request, env, requestId, batchIngredientMatch[1], batchIngredientMatch[2]);
  }
  const batchJournalMatch = /^\/v1\/batches\/(fer_[0-9a-f]{32})\/journal$/u.exec(path);
  if (request.method === "POST" && batchJournalMatch?.[1]) {
    return addBatchJournalEntry(request, env, requestId, batchJournalMatch[1]);
  }
  const batchJournalEntryMatch = /^\/v1\/batches\/(fer_[0-9a-f]{32})\/journal\/(bje_[0-9a-f]{32})$/u.exec(path);
  if (request.method === "DELETE" && batchJournalEntryMatch?.[1] && batchJournalEntryMatch[2]) {
    return deleteBatchJournalEntry(request, env, requestId, batchJournalEntryMatch[1], batchJournalEntryMatch[2]);
  }
  const batchAttachmentsMatch = /^\/v1\/batches\/(fer_[0-9a-f]{32})\/attachments$/u.exec(path);
  if (request.method === "POST" && batchAttachmentsMatch?.[1]) {
    return uploadBatchAttachment(request, env, requestId, batchAttachmentsMatch[1]);
  }
  const batchAttachmentMatch = /^\/v1\/batches\/(fer_[0-9a-f]{32})\/attachments\/(bga_[0-9a-f]{32})$/u.exec(path);
  if (request.method === "GET" && batchAttachmentMatch?.[1] && batchAttachmentMatch[2]) {
    return downloadBatchAttachment(request, env, requestId, batchAttachmentMatch[1], batchAttachmentMatch[2]);
  }
  if (request.method === "DELETE" && batchAttachmentMatch?.[1] && batchAttachmentMatch[2]) {
    return deleteBatchAttachment(request, env, requestId, batchAttachmentMatch[1], batchAttachmentMatch[2]);
  }

  const latestMatch = /^\/v1\/devices\/(MW-[0-9A-F]{12})\/latest$/u.exec(path);
  if (request.method === "GET" && latestMatch?.[1]) {
    return latestDeviceState(request, env, requestId, latestMatch[1]);
  }
  const deviceMatch = /^\/v1\/devices\/(MW-[0-9A-F]{12})$/u.exec(path);
  if (request.method === "PUT" && deviceMatch?.[1]) {
    return updateDevice(request, env, requestId, deviceMatch[1]);
  }
  if (request.method === "DELETE" && deviceMatch?.[1]) {
    return deleteDevice(request, env, requestId, deviceMatch[1]);
  }
  const historyMatch = /^\/v1\/devices\/(MW-[0-9A-F]{12})\/telemetry$/u.exec(path);
  if (request.method === "GET" && historyMatch?.[1]) {
    return deviceHistory(request, env, requestId, historyMatch[1]);
  }
  const fermentationMatch = /^\/v1\/devices\/(MW-[0-9A-F]{12})\/fermentation$/u.exec(path);
  if (request.method === "GET" && fermentationMatch?.[1]) {
    return getFermentation(request, env, requestId, fermentationMatch[1]);
  }
  if (request.method === "POST" && fermentationMatch?.[1]) {
    return startFermentation(request, env, requestId, fermentationMatch[1]);
  }
  const gravityReadingsMatch = /^\/v1\/devices\/(MW-[0-9A-F]{12})\/fermentation\/readings$/u.exec(path);
  if (request.method === "POST" && gravityReadingsMatch?.[1]) {
    return addGravityReading(request, env, requestId, gravityReadingsMatch[1]);
  }
  const gravityReadingMatch = /^\/v1\/devices\/(MW-[0-9A-F]{12})\/fermentation\/readings\/(grv_[0-9a-f]{32})$/u.exec(path);
  if (request.method === "DELETE" && gravityReadingMatch?.[1] && gravityReadingMatch[2]) {
    return deleteGravityReading(request, env, requestId, gravityReadingMatch[1], gravityReadingMatch[2]);
  }
  const finishFermentationMatch = /^\/v1\/devices\/(MW-[0-9A-F]{12})\/fermentation\/finish$/u.exec(path);
  if (request.method === "POST" && finishFermentationMatch?.[1]) {
    return finishFermentation(request, env, requestId, finishFermentationMatch[1]);
  }
  const setpointCommandMatch = /^\/v1\/devices\/(MW-[0-9A-F]{12})\/commands\/setpoint$/u.exec(path);
  if (request.method === "POST" && setpointCommandMatch?.[1]) {
    return createSetpointCommand(request, env, requestId, setpointCommandMatch[1], ctx);
  }
  const profileCommandMatch = /^\/v1\/devices\/(MW-[0-9A-F]{12})\/commands\/profile$/u.exec(path);
  if (request.method === "POST" && profileCommandMatch?.[1]) {
    return createProfileCommand(request, env, requestId, profileCommandMatch[1], ctx);
  }
  const configurationCommandMatch = /^\/v1\/devices\/(MW-[0-9A-F]{12})\/commands\/configuration$/u.exec(path);
  if (request.method === "POST" && configurationCommandMatch?.[1]) {
    return createConfigurationCommand(request, env, requestId, configurationCommandMatch[1], ctx);
  }
  const alarmCommandMatch = /^\/v1\/devices\/(MW-[0-9A-F]{12})\/commands\/alarms$/u.exec(path);
  if (request.method === "POST" && alarmCommandMatch?.[1]) {
    return createAlarmCommand(request, env, requestId, alarmCommandMatch[1], ctx);
  }

  throw new ApiError(404, "ROUTE_NOT_FOUND", "Rota nao encontrada.");
}
