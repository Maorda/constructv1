import { ModuleMetadata, Type } from '@nestjs/common';
export interface GoogleDriveConfig {
    type: string;
    project_id: string;
    private_key_id: string;
    private_key: string;
    client_email: string;
    client_id: string;
    auth_uri: string;
    token_uri: string;
    auth_provider_x509_cert_url: string;
    client_x509_cert_url: string;
}

export interface DatabaseModuleOptions {

    /** Configuración completa del Service Account de Google (JSON) */
    googleDriveConfig: GoogleDriveConfig;

    /** ID de la carpeta raíz en Drive donde se gestionan los archivos */
    googleDriveBaseFolderId: string;

    /** * ID del Spreadsheet principal por defecto. 
     * Opcional si se prefiere inyectar dinámicamente en cada repositorio.
     */
    defaultSpreadsheetId?: string;

    /** * Configuración de salud inicial. 
     * Si es true, el HealthCheck se ejecuta al arrancar.
     */
    checkConnectionOnBoot?: boolean;

    /** Tiempo de espera máximo para respuestas de la API de Google (ms) */
    timeout?: number;
    timezone?: string; // Ejemplo: 'America/Lima', 'Asia/Tokyo', 'UTC'
    formatDates?: boolean;
}


// Esta interfaz permite que el módulo reciba una fábrica (factory) 
// para cargar las opciones de forma asíncrona.
export interface DatabaseModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
    useFactory?: (...args: any[]) => Promise<DatabaseModuleOptions> | DatabaseModuleOptions;
    inject?: any[];
    // Opcional: si quieres soportar useClass o useExisting (estilo Mongoose avanzado)
    useClass?: Type<DatabaseModuleOptionsFactory>;
    useExisting?: Type<DatabaseModuleOptionsFactory>;
}

// Interfaz auxiliar si decides usar el patrón de clase para la configuración
export interface DatabaseModuleOptionsFactory {
    createDatabaseOptions(): Promise<DatabaseModuleOptions> | DatabaseModuleOptions;
}