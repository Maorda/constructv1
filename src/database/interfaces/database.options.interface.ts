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
}