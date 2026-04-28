import { Projection } from "../types/query.types";

export interface BaseServiceInterface<T> {
    applyProjection(data: any, projection: Projection): any;
    executePopulate(data: any, path: string): Promise<any>;
    // ... cualquier otro método que DocumentQuery llame
}