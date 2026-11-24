// This runs inside createPdfium before imports/instantiation. Never consult the
// mutable Module option again: a document cannot promote a render instance.
const bmeRole = Module['bmeRole'];
const bmeRoleLimit = bmeRole === 'render' ? 1073741824 : bmeRole === 'writer' ? 3758096384 : 0;
if (!bmeRoleLimit) throw new Error('A trusted render or writer bmeRole is required');
Module['buildId'] = '__BME_BUILD_ID__';
Module['bmeRoleVersion'] = 1;
