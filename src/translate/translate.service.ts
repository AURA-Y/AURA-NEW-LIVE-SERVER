import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TranslateClient,
  TranslateTextCommand,
} from '@aws-sdk/client-translate';

export type SupportedLanguage = 'ko' | 'zh' | 'ja' | 'en';

export interface TranslateRequest {
  text: string;
  sourceLang?: SupportedLanguage | 'auto';
  targetLang: SupportedLanguage;
}

export interface TranslateResponse {
  translatedText: string;
  sourceLang: string;
  targetLang: string;
}

@Injectable()
export class TranslateService {
  private readonly logger = new Logger(TranslateService.name);
  private translateClient: TranslateClient;

  // AWS Translate 언어 코드 매핑
  private readonly langCodeMap: Record<SupportedLanguage, string> = {
    ko: 'ko',
    zh: 'zh',
    ja: 'ja',
    en: 'en',
  };

  constructor(private configService: ConfigService) {
    this.translateClient = new TranslateClient({
      region: this.configService.get<string>('AWS_REGION') || 'ap-northeast-2',
      credentials: {
        accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
      },
    });

    this.logger.log('[Translate] AWS Translate service initialized');
  }

  /**
   * 텍스트 번역
   */
  async translate(request: TranslateRequest): Promise<TranslateResponse> {
    const { text, sourceLang = 'auto', targetLang } = request;

    if (!text || text.trim().length === 0) {
      return {
        translatedText: '',
        sourceLang: sourceLang === 'auto' ? 'unknown' : sourceLang,
        targetLang,
      };
    }

    try {
      const command = new TranslateTextCommand({
        Text: text,
        SourceLanguageCode: sourceLang === 'auto' ? 'auto' : this.langCodeMap[sourceLang],
        TargetLanguageCode: this.langCodeMap[targetLang],
      });

      const response = await this.translateClient.send(command);

      this.logger.debug(
        `[Translate] "${text.substring(0, 30)}..." → "${response.TranslatedText?.substring(0, 30)}..."`,
      );

      return {
        translatedText: response.TranslatedText || text,
        sourceLang: response.SourceLanguageCode || 'unknown',
        targetLang,
      };
    } catch (error) {
      this.logger.error(`[Translate] Error: ${error.message}`);
      throw error;
    }
  }

  /**
   * 여러 텍스트 일괄 번역
   */
  async translateBatch(
    texts: string[],
    sourceLang: SupportedLanguage | 'auto' = 'auto',
    targetLang: SupportedLanguage,
  ): Promise<TranslateResponse[]> {
    const results = await Promise.all(
      texts.map((text) =>
        this.translate({ text, sourceLang, targetLang }),
      ),
    );
    return results;
  }
}
