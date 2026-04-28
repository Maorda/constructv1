// --- CORAZÓN DEL MÓDULO ---
export * from './database.module';

// --- INFRAESTRUCTURA Y CONTEXTO ---
// Esto es vital para que tus repositorios puedan inyectar el contexto
export { RepositoryContext } from './repositories/repository.context';
export { SheetsRepository } from './repositories/sheet.repository';

// --- CLASES BASE Y REPOSITORIOS ---
// Exportamos la clase base para que tus servicios puedan hacer "extends"
export * from './services/base.sheets.crud.service';

// --- DECORADORES ---
// Los "etiquetadores" de tus entidades
export * from './decorators/table.decorator';
export * from './decorators/column.decorator';
export * from './decorators/relation.decorator';

// --- INTERFACES ---
// Necesarias para configurar registerAsync y forRoot
export * from './interfaces/database.options.interface';

// --- ESTRATEGIAS ---
export { NamingStrategy } from './strategy/naming.strategy';

// --- MOTORES (Opcional) ---
// Solo expórtalos si planeas usarlos manualmente fuera de la librería.
// Si el RepositoryContext ya los maneja, no es estrictamente necesario,
// pero es buena práctica por si necesitas hacer consultas personalizadas.
export { SheetsQuery } from './engines/sheet.query';
export { DocumentQuery } from './engines/document.query';