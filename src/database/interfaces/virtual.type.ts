export interface VirtualType {
    get?: () => any;
    set?: (value: any) => void;
}