// Own synthetic input; compiled only into temporary files by test_tools.py.
var targetStrings = ['join', 'eval', '', '日本語', '\ud800', '😀', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'];
function guarded(x) { try { return x.m(); } catch (e) { return 'caught'; } }
function choose(x) { switch(x) { case 1:return 'one'; case 2:return 'two';case 3:return 'three';case 4:return 'four';default:return 'other'; } }
function words(x) {switch(x) { case 'ab':return 1;case 'cd':return 2;case 'ef':return 3;case 'gh':return 4;case 'ij':return 5;case 'kl':return 6;case 'mn':return 7;case 'op':return 8;case 'qr':return 9;case 'st':return 10;default:return 0;}}
__d(function(global, require, importDefault, importAll, module, exports, deps) { exports.hello = function() {return 'fixture-value' + '\ud800';}; }, 42, [1, 2]);
