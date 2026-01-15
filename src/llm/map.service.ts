import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SearchResult } from './search.service';

@Injectable()
export class MapService {
    private readonly logger = new Logger(MapService.name);
    private readonly naverMapKeyId: string;
    private readonly naverMapKey: string;

    constructor(private configService: ConfigService) {
        this.naverMapKeyId = this.configService.get<string>('NAVER_MAP_API_KEY_ID') || '';
        this.naverMapKey = this.configService.get<string>('NAVER_MAP_API_KEY') || '';
        
        if (this.naverMapKeyId && this.naverMapKey) {
            const maskedId = this.naverMapKeyId.slice(-4);
            this.logger.log(`[MapKey] NAVER_MAP_API_KEY_ID=****${maskedId}`);
        } else {
            this.logger.warn('[MapKey] NAVER_MAP_API_KEY_ID/API_KEY is missing');
        }
    }

    // ============================================================
    // Route Info
    // ============================================================

    async getRouteInfo(result: SearchResult): Promise<{
        origin: { lng: string; lat: string };
        destination: { lng: string; lat: string; name: string };
        distance: number;
        durationMs: number;
        directionUrl?: string;
        path?: { lng: string; lat: string }[];
    } | null> {
        const origin = this.configService.get<string>('NAVER_MAP_ORIGIN') || '';
        if (!origin) {
            this.logger.warn('[길찾기] NAVER_MAP_ORIGIN 없음');
            return null;
        }
        const [originLng, originLat] = origin.split(',').map(v => v.trim());
        if (!originLng || !originLat) return null;

        let destLng: string, destLat: string;
        if (result.mapx && result.mapy) {
            destLng = String(Number(result.mapx) / 10000000);
            destLat = String(Number(result.mapy) / 10000000);
        } else {
            return null;
        }

        const directionUrl = this.buildDirectionUrlFromCoords(
            originLat, originLng, destLat, destLng,
            result.title || '목적지', result.placeId
        );

        // Directions API
        if (this.naverMapKeyId && this.naverMapKey) {
            try {
                const apiUrl = new URL('https://maps.apigw.ntruss.com/map-direction/v1/driving');
                apiUrl.searchParams.set('start', `${originLng},${originLat}`);
                apiUrl.searchParams.set('goal', `${destLng},${destLat}`);
                apiUrl.searchParams.set('option', 'trafast');

                const resp = await fetch(apiUrl.toString(), {
                    headers: {
                        'X-NCP-APIGW-API-KEY-ID': this.naverMapKeyId,
                        'X-NCP-APIGW-API-KEY': this.naverMapKey,
                    },
                });

                if (resp.ok) {
                    const body = await resp.json();
                    const summary = body?.route?.trafast?.[0]?.summary;
                    const path = body?.route?.trafast?.[0]?.path;
                    if (summary) {
                        return {
                            origin: { lng: originLng, lat: originLat },
                            destination: { lng: destLng, lat: destLat, name: result.title || '' },
                            distance: Number(summary.distance || 0),
                            durationMs: Number(summary.duration || 0),
                            directionUrl,
                            path: Array.isArray(path)
                                ? path.map((p: number[]) => ({ lng: String(p[0]), lat: String(p[1]) }))
                                : undefined,
                        };
                    }
                }
            } catch (e) {
                this.logger.warn(`[길찾기 API 실패] ${e.message}`);
            }
        }

        // 직선 거리 추정
        const distance = this.computeDistanceMeters(
            { lng: originLng, lat: originLat },
            { lng: destLng, lat: destLat }
        );
        const estimatedDistance = Math.round(distance * 1.3);
        const estimatedDuration = Math.round(estimatedDistance / 30 * 3.6 * 1000);

        return {
            origin: { lng: originLng, lat: originLat },
            destination: { lng: destLng, lat: destLat, name: result.title || '' },
            distance: estimatedDistance,
            durationMs: estimatedDuration,
            directionUrl,
        };
    }

    // ============================================================
    // Static Map Image
    // ============================================================

    async getStaticMapImage(params: {
        origin: { lng: string; lat: string };
        destination: { lng: string; lat: string };
        width: number;
        height: number;
        path?: { lng: string; lat: string }[];
        distanceMeters?: number;
    }): Promise<{ buffer: Buffer; contentType: string } | null> {
        if (!this.naverMapKeyId || !this.naverMapKey) return null;

        const { origin, destination, width, height, path, distanceMeters } = params;
        const rawPath = path && path.length > 1 ? path : [origin, destination];
        const bounds = this.computeBounds(rawPath);
        const centerLng = (bounds.minLng + bounds.maxLng) / 2;
        const centerLat = (bounds.minLat + bounds.maxLat) / 2;
        const distance = distanceMeters ?? this.computeDistanceMeters(origin, destination);
        const level = this.pickStaticMapLevel(distance);

        const url = new URL('https://maps.apigw.ntruss.com/map-static/v2/raster');
        url.searchParams.set('w', String(width));
        url.searchParams.set('h', String(height));
        url.searchParams.set('format', 'png');
        url.searchParams.set('scale', '2');
        url.searchParams.set('center', `${centerLng},${centerLat}`);
        url.searchParams.set('level', String(level));
        url.searchParams.set('maptype', 'basic');
        url.searchParams.append('markers', `type:d|size:mid|color:0x1d4ed8|pos:${origin.lng} ${origin.lat}|label:출발`);
        url.searchParams.append('markers', `type:d|size:mid|color:0xf97316|pos:${destination.lng} ${destination.lat}|label:도착`);

        if (rawPath.length > 1) {
            const pathParts = rawPath.map(p => `pos:${p.lng} ${p.lat}`).join('|');
            url.searchParams.append('path', `weight:5|color:0x2563eb|${pathParts}`);
        }

        const response = await fetch(url.toString(), {
            headers: {
                'X-NCP-APIGW-API-KEY-ID': this.naverMapKeyId,
                'X-NCP-APIGW-API-KEY': this.naverMapKey,
            },
        });

        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        return { buffer: Buffer.from(arrayBuffer), contentType: 'image/png' };
    }

    // ============================================================
    // URL Builders
    // ============================================================

    buildNaverDirectionUrl(mapx: string, mapy: string, title: string, placeId?: string): string | null {
        const origin = this.configService.get<string>('NAVER_MAP_ORIGIN');
        if (!origin || !mapx || !mapy) return null;

        const [originX, originY] = origin.split(',').map(v => v.trim());
        if (!originX || !originY) return null;

        const parsedMapx = Number(mapx);
        const parsedMapy = Number(mapy);
        if (Number.isNaN(parsedMapx) || Number.isNaN(parsedMapy)) return null;

        const destLng = (parsedMapx / 10000000).toString();
        const destLat = (parsedMapy / 10000000).toString();

        // 네이버 지도 길찾기 URL (대중교통)
        const encodedOrigin = encodeURIComponent('출발지');
        const encodedTitle = encodeURIComponent(title || '목적지');
        return `https://map.naver.com/v5/directions/${originX},${originY},${encodedOrigin}/${destLng},${destLat},${encodedTitle}/transit`;
    }

    private buildDirectionUrlFromCoords(
        originLat: string, originLng: string,
        destLat: string, destLng: string,
        name: string, placeId?: string
    ): string {
        // 네이버 지도 길찾기 URL (대중교통)
        const encodedOrigin = encodeURIComponent('출발지');
        const encodedName = encodeURIComponent(name || '목적지');
        return `https://map.naver.com/v5/directions/${originLng},${originLat},${encodedOrigin}/${destLng},${destLat},${encodedName}/transit`;
    }

    // ============================================================
    // Geometry Helpers
    // ============================================================

    private computeBounds(points: { lng: string; lat: string }[]) {
        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const p of points) {
            const lng = Number(p.lng), lat = Number(p.lat);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
            minLng = Math.min(minLng, lng);
            maxLng = Math.max(maxLng, lng);
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
        }
        return { minLng, maxLng, minLat, maxLat };
    }

    private pickStaticMapLevel(distanceMeters: number): number {
        if (distanceMeters > 15000) return 11;
        if (distanceMeters > 8000) return 12;
        if (distanceMeters > 4000) return 13;
        if (distanceMeters > 2000) return 14;
        return 15;
    }

    private computeDistanceMeters(
        origin: { lng: string; lat: string },
        destination: { lng: string; lat: string }
    ): number {
        const R = 6371000;
        const lat1 = Number(origin.lat) * Math.PI / 180;
        const lat2 = Number(destination.lat) * Math.PI / 180;
        const deltaLat = (Number(destination.lat) - Number(origin.lat)) * Math.PI / 180;
        const deltaLng = (Number(destination.lng) - Number(origin.lng)) * Math.PI / 180;
        const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}