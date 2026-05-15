/**
 * METADATA CONSTANTS - UNIFICADAS
 * Solo una llave por cada propósito para evitar el retorno {}
 */

// 1. NIVEL DE TABLA (CLASE)
export const SHEETS_TABLE_NAME = Symbol('sheets:table_name');

// 2. NIVEL DE COLUMNAS (LISTA Y DETALLES)
// La lista de nombres de propiedades (Array)
export const SHEETS_COLUMN_LIST = Symbol('sheets:column_list');
// La configuración individual de cada @Column
export const TABLE_COLUMN_KEY = Symbol('sheets:table_column');
// El mapa completo de detalles (Mapa Record) - Para compatibilidad
export const SHEETS_COLUMN_DETAILS = Symbol('sheets:column_details');

// 3. IDENTIDAD Y ESTADO
export const SHEETS_PRIMARY_KEY = Symbol('sheets:primary_key');
export const SHEETS_DELETE_CONTROL = Symbol('sheets:delete_control');

// 4. NIVEL DE RELACIONES
export const SHEETS_RELATIONS_LIST = Symbol('sheets:relations_list');
export const SHEETS_ALL_RELATIONS = Symbol('sheets:all_relations');

// 5. OTROS
export const SHEETS_VIRTUALS = Symbol('sheets:virtuals');