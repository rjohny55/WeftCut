import {describe,expect,it} from 'vitest';
import {exportMotifHostLimit} from './exportHostLimit';
describe('export resident host ceiling',()=>{
  it('accepts only bounded whole counts and preserves the shipping default',()=>{
    for(const value of [undefined,null,0,13,Infinity,1.5,'8x','1.5','-1','auto'])expect(exportMotifHostLimit(value)).toBe(3);
    for(const value of [1,3,8,12,'1','8','12'])expect(exportMotifHostLimit(value)).toBe(Number(value));
  });
});
