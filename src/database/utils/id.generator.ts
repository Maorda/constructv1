import { v4 as uuidv4 } from 'uuid';

export class IdGenerator {
    /**
     * Genera un UUID v4 estándar
     * Ejemplo: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'
     */
    static generate(): string {
        return uuidv4();
    }

    /**
     * Genera un ID corto y legible si prefieres algo menos extenso
     * (Requiere la librería nanoid)
     */
    static generateShort(): string {
        // Ejemplo: 'V1StGXR8_Z5jdHi6B-myT'
        return uuidv4().split('-')[0].toUpperCase();
    }
}