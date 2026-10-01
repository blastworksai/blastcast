# CodexBWAI. Approved branding-only PE resources; verify every non-resource PE section unchanged.
param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$Png,[Parameter(Mandatory=$true)][string]$Icon,[Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Three-part version required.' }
if(Test-Path -LiteralPath $Icon) { throw 'Icon output already exists.' }
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing,System.Core -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Security.Cryptography;
public static class BlastCastBrand {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr BeginUpdateResource(string file,bool deleteExisting);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateResource(IntPtr update,IntPtr type,IntPtr name,ushort language,byte[] data,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool EndUpdateResource(IntPtr update,bool discard);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr LoadLibraryEx(string file,IntPtr unused,uint flags);
 [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr library);
 delegate bool NameCallback(IntPtr library,IntPtr type,IntPtr name,IntPtr param);
 delegate bool LanguageCallback(IntPtr library,IntPtr type,IntPtr name,ushort language,IntPtr param);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool EnumResourceNames(IntPtr library,IntPtr type,NameCallback callback,IntPtr param);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool EnumResourceLanguages(IntPtr library,IntPtr type,IntPtr name,LanguageCallback callback,IntPtr param);
 static void Check(bool result) { if(!result) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
 static byte[] Bytes(Action<BinaryWriter> write) { using(var s=new MemoryStream()) { using(var w=new BinaryWriter(s,Encoding.Unicode,true)) write(w); return s.ToArray(); } }
 static void Pad(BinaryWriter w) { while(w.BaseStream.Position%4!=0) w.Write((byte)0); }
 static byte[] Block(string key,byte[] value,ushort type,ushort valueLength,params byte[][] children) {
  var bytes=Bytes(w=>{w.Write((ushort)0);w.Write(valueLength);w.Write(type);w.Write(Encoding.Unicode.GetBytes(key+"\0"));Pad(w);w.Write(value);foreach(var child in children){Pad(w);w.Write(child);}});
  Array.Copy(BitConverter.GetBytes((ushort)bytes.Length),bytes,2); return bytes;
 }
 static byte[] Version(string version) {
  var v=version.Split('.').Select(UInt16.Parse).ToArray();
  var fixedInfo=Bytes(w=>{foreach(uint x in new uint[]{0xFEEF04BD,0x10000,((uint)v[0]<<16)|v[1],((uint)v[2]<<16),((uint)v[0]<<16)|v[1],((uint)v[2]<<16),0x3f,0,0x40004,1,0,0,0})w.Write(x);});
  var strings=new Dictionary<string,string>{{"CompanyName","BlastworksAI"},{"FileDescription","BlastCast"},{"FileVersion",version},{"InternalName","BlastCast"},{"OriginalFilename","BlastCast.exe"},{"ProductName","BlastCast"},{"ProductVersion",version},{"LegalCopyright","BlastworksAI; Electron and Chromium third-party notices included"}};
  var leaves=strings.Select(p=>Block(p.Key,Encoding.Unicode.GetBytes(p.Value+"\0"),1,(ushort)(p.Value.Length+1))).ToArray();
  var stringInfo=Block("StringFileInfo",new byte[0],1,0,Block("040904b0",new byte[0],1,0,leaves));
  var vars=Block("VarFileInfo",new byte[0],1,0,Block("Translation",new byte[]{9,4,176,4},0,4));
  return Block("VS_VERSION_INFO",fixedInfo,0,(ushort)fixedInfo.Length,stringInfo,vars);
 }
 public static Dictionary<string,string> CodeSections(string file) {
  var data=File.ReadAllBytes(file);var pe=BitConverter.ToInt32(data,0x3c);var count=BitConverter.ToUInt16(data,pe+6);var table=pe+24+BitConverter.ToUInt16(data,pe+20);var result=new Dictionary<string,string>();
  using(var hash=SHA256.Create()) for(int i=0;i<count;i++){var entry=table+i*40;var name=Encoding.ASCII.GetString(data,entry,8).TrimEnd('\0');if(name==".rsrc")continue;var size=BitConverter.ToInt32(data,entry+16);var start=BitConverter.ToInt32(data,entry+20);result[name]=BitConverter.ToString(hash.ComputeHash(data,start,size)).Replace("-","").ToLowerInvariant();}return result;
 }
 public static void Apply(string file,string png,string icon,string version) {
  var icons=new List<byte[]>();var sizes=new[]{16,32,48,256};
  using(var original=new Bitmap(png))foreach(int size in sizes){using(var b=new Bitmap(size,size,System.Drawing.Imaging.PixelFormat.Format32bppArgb)){using(var g=Graphics.FromImage(b)){g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.DrawImage(original,0,0,size,size);}icons.Add(Bytes(w=>{w.Write(40);w.Write(size);w.Write(size*2);w.Write((ushort)1);w.Write((ushort)32);w.Write(0);w.Write(size*size*4);w.Write(0);w.Write(0);w.Write(0);w.Write(0);for(int y=size-1;y>=0;y--)for(int x=0;x<size;x++){var c=b.GetPixel(x,y);w.Write(c.B);w.Write(c.G);w.Write(c.R);w.Write(c.A);}w.Write(new byte[((size+31)/32)*4*size]);}));}}
  File.WriteAllBytes(icon,Bytes(w=>{w.Write((ushort)0);w.Write((ushort)1);w.Write((ushort)icons.Count);int offset=6+16*icons.Count;for(int i=0;i<icons.Count;i++){w.Write((byte)(sizes[i]%256));w.Write((byte)(sizes[i]%256));w.Write((ushort)0);w.Write((ushort)1);w.Write((ushort)32);w.Write(icons[i].Length);w.Write(offset);offset+=icons[i].Length;}foreach(var data in icons)w.Write(data);}));
  // Snapshot existing resource identities before closing the read-only module handle.
  var remove=new List<Tuple<int,int,ushort>>();var module=LoadLibraryEx(file,IntPtr.Zero,2);if(module==IntPtr.Zero)throw new System.ComponentModel.Win32Exception();
  try{foreach(int kind in new[]{3,14,16}){EnumResourceNames(module,(IntPtr)kind,(m,t,n,p)=>{if(n.ToInt64()>65535)throw new InvalidOperationException("Named icon/version resources unsupported.");EnumResourceLanguages(m,t,n,(lm,lt,ln,lang,lp)=>{remove.Add(Tuple.Create(kind,n.ToInt32(),lang));return true;},IntPtr.Zero);return true;},IntPtr.Zero);}}finally{FreeLibrary(module);}
  var update=BeginUpdateResource(file,false);if(update==IntPtr.Zero)throw new System.ComponentModel.Win32Exception();bool commit=false;
  try{foreach(var resource in remove)Check(UpdateResource(update,(IntPtr)resource.Item1,(IntPtr)resource.Item2,resource.Item3,null,0));for(int i=0;i<icons.Count;i++)Check(UpdateResource(update,(IntPtr)3,(IntPtr)(1001+i),1033,icons[i],(uint)icons[i].Length));var group=Bytes(w=>{w.Write((ushort)0);w.Write((ushort)1);w.Write((ushort)icons.Count);for(int i=0;i<icons.Count;i++){w.Write((byte)(sizes[i]%256));w.Write((byte)(sizes[i]%256));w.Write((ushort)0);w.Write((ushort)1);w.Write((ushort)32);w.Write(icons[i].Length);w.Write((ushort)(1001+i));}});Check(UpdateResource(update,(IntPtr)14,(IntPtr)1,1033,group,(uint)group.Length));var ver=Version(version);Check(UpdateResource(update,(IntPtr)16,(IntPtr)1,1033,ver,(uint)ver.Length));commit=true;}finally{Check(EndUpdateResource(update,!commit));}
 }
}
'@
$before=[BlastCastBrand]::CodeSections($Executable)
$beforeHash=(Get-FileHash -LiteralPath $Executable).Hash.ToLowerInvariant()
[BlastCastBrand]::Apply($Executable,$Png,$Icon,$Version)
$after=[BlastCastBrand]::CodeSections($Executable)
if($before.Count -ne $after.Count) { throw 'PE section count changed.' }
foreach($name in $before.Keys) { if(-not $after.ContainsKey($name) -or $before[$name] -ne $after[$name]) { throw "Non-resource section changed: $name" } }
$info=[Diagnostics.FileVersionInfo]::GetVersionInfo($Executable)
if($info.CompanyName -ne 'BlastworksAI' -or $info.ProductName -ne 'BlastCast' -or $info.FileDescription -ne 'BlastCast' -or $info.ProductVersion -ne $Version) { throw 'Branded version resource did not verify.' }
@{author='CodexBWAI';executable=$Executable;beforeSha256=$beforeHash;afterSha256=(Get-FileHash -LiteralPath $Executable).Hash.ToLowerInvariant();iconSha256=(Get-FileHash -LiteralPath $Icon).Hash.ToLowerInvariant();companyName=$info.CompanyName;productName=$info.ProductName;fileDescription=$info.FileDescription;productVersion=$info.ProductVersion;nonResourceSectionsUnchanged=$true;signed=$false} | ConvertTo-Json | Set-Content -LiteralPath ($Executable+'.branding.json') -Encoding UTF8
