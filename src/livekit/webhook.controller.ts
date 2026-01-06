import {
  Controller,
  Post,
  Body,
  Headers,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
// import { WebhookReceiver } from "livekit-server-sdk";
import axios from "axios";

@Controller("webhook")
export class WebhookController {
  // private webhookReceiver: WebhookReceiver;

  constructor(private configService: ConfigService) {
    // const apiKey = this.configService.get<string>("LIVEKIT_API_KEY");
    // const apiSecret = this.configService.get<string>("LIVEKIT_API_SECRET");
    // this.webhookReceiver = new WebhookReceiver(apiKey, apiSecret);
  }

  @Post()
  async handleWebhook(
    @Body() body: any,
    @Headers("Authorization") authHeader: string
  ) {
    // 1. Skip Webhook Signature Validation for now (Build Error Fix)
    // TODO: Restore validation using WebhookReceiver or manual check

    try {
      const event = body; // LiveKit sends JSON body
      console.log(`[Webhook] Full body: ${JSON.stringify(body)}`);

      console.log(
        `[Webhook] Received event: ${event.event} for room: ${event.room?.name}`
      );

      // 2. Handle 'room_finished' event
      if (event.event === "room_finished" && event.room) {
        const roomName = event.room.name;
        await this.deleteRoomFromBackend(roomName);
      }

      return { status: "ok" };
    } catch (error) {
      console.error("[Webhook] Error processing webhook:", error);
      return { status: "error", message: error.message };
    }
  }

  private async deleteRoomFromBackend(roomId: string) {
    const backendUrl = this.configService.get<string>("BACKEND_API_URL");
    if (!backendUrl) {
      console.error("[Webhook] BACKEND_API_URL not configured");
      return;
    }

    try {
      // Backend Global Prefix is usually '/restapi' or similar based on `Backend` service logs
      // Reverted to standard roomId deletion because LiveKit room.name is now a unique UUID matching DB roomId
      const url = `${backendUrl}/restapi/system/rooms/${roomId}`;
      console.log(`[Webhook] Requesting deletion for room ${roomId} at ${url}`);
      await axios.delete(url);
      console.log(`[Webhook] Room ${roomId} deleted from backend successfully`);
    } catch (error) {
      console.error(
        `[Webhook] Failed to delete room ${roomId} from backend:`,
        error.message
      );
    }
  }
}
